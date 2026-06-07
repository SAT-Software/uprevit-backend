import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	BILLING_ACCOUNTS_COLLECTION,
	type BillingAccount,
	type BillingAccountStatus,
	type BillingCadence,
	type BillingPaymentMode,
	type UsageLimits,
} from '../../models/billing';
import { Workspace } from '../../models/workspace';
import { getDb } from '../../utils/db';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { recordPlatformAuditEvent } from '../../utils/platformAuditLog';
import {
	getBillingAccountByWorkspaceId,
	normalizeUsageLimits,
	usageLimitsToIncluded,
} from '../../utils/billing/billingAccounts';
import { recordSsoAddOnEvent } from '../../utils/billing/usageRecording';
import { parseOptionalIsoDate } from '../../utils/billing/billingPeriod';
import { serializeBillingAccount } from '../../utils/billing/serializers';

const ACCOUNT_STATUSES: BillingAccountStatus[] = ['draft', 'pilot', 'active', 'past_due', 'cancelled'];
const CADENCES: BillingCadence[] = ['monthly', 'yearly'];
const PAYMENT_MODES: BillingPaymentMode[] = ['offline_wire', 'provider_bank_transfer', 'manual_external'];

type UpdateBillingInput = {
	status?: BillingAccountStatus;
	meteringEnabled?: boolean;
	limitsEnabled?: boolean;
	billingCadence?: BillingCadence;
	currency?: string;
	netTermDays?: number;
	paymentMode?: BillingPaymentMode;
	periodStart?: string;
	periodEnd?: string;
	pastDue?: boolean;
	included?: {
		seatMonths?: number;
		exports?: number;
		uploadGb?: number;
		sso?: boolean;
	};
	usageLimits?: Partial<UsageLimits>;
	ssoEnabled?: boolean;
};

/**
 * Updates billing account fields for platform operators.
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const workspaceId = event.pathParameters?.workspaceId;
		if (!workspaceId || !ObjectId.isValid(workspaceId)) {
			return ResponseWrapper.badRequest('workspaceId must be a valid ObjectId');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input: UpdateBillingInput;
		try {
			input = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const workspaceObjectId = new ObjectId(workspaceId);
		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceObjectId });
		if (!workspace) return ResponseWrapper.notFound('Workspace not found');

		const existing = await getBillingAccountByWorkspaceId(workspaceObjectId);
		if (!existing) return ResponseWrapper.notFound('Billing account not found');

		const updates: Record<string, unknown> = {};
		const now = new Date();
		const isCountLimit = (path: keyof Omit<UsageLimits, 'ssoAllowed'>) => path === 'seats' || path === 'exports';

		if (input.status !== undefined) {
			if (!ACCOUNT_STATUSES.includes(input.status)) {
				return ResponseWrapper.badRequest('Invalid billing account status');
			}
			updates.status = input.status;
		}
		if (typeof input.limitsEnabled === 'boolean') updates.meteringEnabled = input.limitsEnabled;
		if (typeof input.meteringEnabled === 'boolean') updates.meteringEnabled = input.meteringEnabled;
		if (input.billingCadence !== undefined) {
			if (!CADENCES.includes(input.billingCadence)) {
				return ResponseWrapper.badRequest('billingCadence must be monthly or yearly');
			}
			updates.billingCadence = input.billingCadence;
		}
		if (typeof input.currency === 'string' && input.currency.trim()) updates.currency = input.currency.trim();
		if (typeof input.netTermDays === 'number' && input.netTermDays >= 0) updates.netTermDays = input.netTermDays;
		if (input.paymentMode !== undefined) {
			if (!PAYMENT_MODES.includes(input.paymentMode)) {
				return ResponseWrapper.badRequest('Invalid payment mode');
			}
			updates.paymentMode = input.paymentMode;
		}
		if (typeof input.pastDue === 'boolean') updates.pastDue = input.pastDue;
		if (input.periodStart !== undefined) {
			const parsedPeriodStart = parseOptionalIsoDate(input.periodStart, 'periodStart');
			if (!parsedPeriodStart.ok) return ResponseWrapper.badRequest(parsedPeriodStart.message);
			updates.periodStart = parsedPeriodStart.date;
		}
		if (input.periodEnd !== undefined) {
			const parsedPeriodEnd = parseOptionalIsoDate(input.periodEnd, 'periodEnd');
			if (!parsedPeriodEnd.ok) return ResponseWrapper.badRequest(parsedPeriodEnd.message);
			updates.periodEnd = parsedPeriodEnd.date;
		}

		const usageLimits = normalizeUsageLimits(existing);
		let usageLimitsChanged = false;
		const applyNumericLimit = (path: keyof Omit<UsageLimits, 'ssoAllowed'>, value: unknown): boolean | APIGatewayProxyResult => {
			if (value === undefined) return false;
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
				return ResponseWrapper.badRequest(`${path} must be a non-negative number`);
			}
			if (isCountLimit(path) && !Number.isInteger(value)) {
				return ResponseWrapper.badRequest(`${path} must be a whole number`);
			}
			usageLimits[path] = value;
			return true;
		};

		const seatLimitResult = applyNumericLimit('seats', input.usageLimits?.seats ?? input.included?.seatMonths);
		if (typeof seatLimitResult !== 'boolean') return seatLimitResult;
		usageLimitsChanged = usageLimitsChanged || seatLimitResult;

		const exportLimitResult = applyNumericLimit('exports', input.usageLimits?.exports ?? input.included?.exports);
		if (typeof exportLimitResult !== 'boolean') return exportLimitResult;
		usageLimitsChanged = usageLimitsChanged || exportLimitResult;

		const uploadLimitResult = applyNumericLimit('uploadGb', input.usageLimits?.uploadGb ?? input.included?.uploadGb);
		if (typeof uploadLimitResult !== 'boolean') return uploadLimitResult;
		usageLimitsChanged = usageLimitsChanged || uploadLimitResult;

		const ssoAllowedInput = input.usageLimits?.ssoAllowed ?? input.included?.sso;
		if (ssoAllowedInput !== undefined) {
			if (typeof ssoAllowedInput !== 'boolean') {
				return ResponseWrapper.badRequest('ssoAllowed must be a boolean');
			}
			usageLimits.ssoAllowed = ssoAllowedInput;
			usageLimitsChanged = true;
		}

		if (usageLimitsChanged) {
			updates.usageLimits = usageLimits;
			updates.included = usageLimitsToIncluded(usageLimits);
		}

		let ssoAction: 'enabled' | 'disabled' | null = null;
		if (typeof input.ssoEnabled === 'boolean' && input.ssoEnabled !== existing.sso.enabled) {
			if (input.ssoEnabled && !usageLimits.ssoAllowed) {
				return ResponseWrapper.badRequest('SSO is not allowed by this workspace usage limit');
			}
			updates['sso.enabled'] = input.ssoEnabled;
			updates[`sso.${input.ssoEnabled ? 'enabledAt' : 'disabledAt'}`] = now;
			ssoAction = input.ssoEnabled ? 'enabled' : 'disabled';
		}

		if (Object.keys(updates).length === 0) {
			return ResponseWrapper.badRequest('No valid fields to update');
		}

		updates.updatedAt = now;

		const updated = await db.collection(BILLING_ACCOUNTS_COLLECTION).findOneAndUpdate(
			{ _id: existing._id },
			{ $set: updates },
			{ returnDocument: 'after' },
		);

		if (!updated) return ResponseWrapper.notFound('Billing account not found');

		if (ssoAction) {
			await recordSsoAddOnEvent({
				workspaceId: workspaceObjectId,
				billingAccountId: existing._id,
				action: ssoAction,
			});
		}

		const { auth, operator } = operatorResult.context;
		await recordPlatformAuditEvent({
			action: 'billing.account.update',
			targetType: 'billing_account',
			workspaceId: workspaceObjectId,
			entityId: existing._id.toString(),
			summary: `Updated billing account for ${workspace.workspaceName}`,
			changes: Object.keys(updates).map((path) => ({ path, to: updates[path] })),
			auth: auth.payload,
			operator,
			event,
			source: 'platform-admin-portal',
		});

		return ResponseWrapper.success({
			message: 'Billing account updated',
			data: serializeBillingAccount(updated as BillingAccount & { _id: ObjectId }),
		});
	} catch (error) {
		logError('Platform admin update billing account failed', error);
		return ResponseWrapper.internalServerError('Failed to update billing account');
	}
};
