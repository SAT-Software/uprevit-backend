import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest, type AuthResult } from './authUtils';
import { getAuthenticatedUserContext, type AuthenticatedUserContext } from './authenticatedUser';
import { EDITOR_USER_TYPES, type User } from '../models/user';
import { assertWorkspaceAccessAllowed } from './billing/enforcement';
import { ResponseWrapper } from './responseWrapper';
import { setTelemetryIdentity } from './telemetry';

export type TenantContext = {
	workspaceId: ObjectId;
	userId: ObjectId;
	cognitoSub: string;
	cognitoGroups: string[];
	userType: User['userType'];
	isManager: boolean;
};

export type TenantContextResult =
	| { ok: true; context: TenantContext; auth: Extract<AuthResult, { isValid: true }> }
	| { ok: false; response: APIGatewayProxyResult };

export const parseCognitoGroups = (groups: unknown): string[] => {
	if (Array.isArray(groups)) {
		return groups.filter((group): group is string => typeof group === 'string');
	}

	if (typeof groups === 'string') {
		return groups.split(',').map((group) => group.trim()).filter(Boolean);
	}

	return [];
};

/**
 * Authenticates the request and resolves the caller's workspace from MongoDB.
 * @param {APIGatewayProxyEvent} event - API Gateway event
 * @return {Promise<TenantContextResult>} Tenant context result
*/
export type RequireTenantContextOptions = {
	/** Allow read-only access when workspace access is frozen (e.g. billing summary). */
	allowAccessFrozen?: boolean;
	/** Reject Approvers and Manager-only members, who have read-only access to workspace data. */
	requireEditor?: boolean;
};

export const requireTenantContext = async (
	event: APIGatewayProxyEvent,
	options: RequireTenantContextOptions = {},
): Promise<TenantContextResult> => {
	const auth = await authenticateRequest(event);
	if (!auth.isValid) {
		return { ok: false, response: auth.error };
	}

	const cognitoSub = auth.payload.sub;
	if (!cognitoSub) {
		return { ok: false, response: ResponseWrapper.unauthorized('Unauthorized') };
	}

	const userContext = await getAuthenticatedUserContext(cognitoSub);
	if (!userContext) {
		return {
			ok: false,
			response: ResponseWrapper.unauthorized('Unable to resolve authenticated user context'),
		};
	}
	setTelemetryIdentity(userContext.userId, userContext.workspaceId);

	if (options.requireEditor && !canEditWorkspaceData(userContext)) {
		return { ok: false, response: ResponseWrapper.forbidden(READ_ONLY_MESSAGE) };
	}

	if (!options.allowAccessFrozen) {
		const accessCheck = await assertWorkspaceAccessAllowed(userContext.workspaceId);
		if (!accessCheck.allowed) {
			return {
				ok: false,
				response: ResponseWrapper.forbidden(accessCheck.reason),
			};
		}
	}

	return {
		ok: true,
		context: {
			workspaceId: userContext.workspaceId,
			userId: userContext.userId,
			cognitoSub,
			cognitoGroups: parseCognitoGroups(auth.payload['cognito:groups']),
			userType: userContext.userType,
			isManager: userContext.isManager,
		},
		auth,
	};
};

/**
 * Returns a 403 response when the requested workspace does not match the caller's workspace.
 * @param {string | ObjectId} requestedWorkspaceId - The requested workspace id
 * @param {ObjectId} contextWorkspaceId - The context workspace id
 * @param {string} message - The message to return in the response
 * @return {APIGatewayProxyResult | null} The response or null if the workspaces match
*/
export const assertWorkspaceMatch = (
	requestedWorkspaceId: string | ObjectId,
	contextWorkspaceId: ObjectId,
	message = 'You are not authorized to access resources for this workspace',
): APIGatewayProxyResult | null => {
	if (!(requestedWorkspaceId instanceof ObjectId)) {
		const requestedWorkspaceIdString = requestedWorkspaceId.toString().trim();
		if (!ObjectId.isValid(requestedWorkspaceIdString)) {
			return ResponseWrapper.badRequest('Invalid workspace id');
		}
	}

	let requestedId: ObjectId;
	try {
		requestedId = requestedWorkspaceId instanceof ObjectId
			? requestedWorkspaceId
			: new ObjectId(requestedWorkspaceId.toString());
	} catch {
		return ResponseWrapper.badRequest('Invalid workspace id');
	}

	if (requestedId.toString() !== contextWorkspaceId.toString()) {
		return ResponseWrapper.forbidden(message);
	}

	return null;
};

/**
 * Standard Mongo filter for tenant-scoped resource lookups by id.
 * @param {string | ObjectId} resourceId - The resource id
 * @param {ObjectId} workspaceId - The workspace id
 * @return {Object} The filter object
*/
export const tenantObjectIdFilter = (
	resourceId: string | ObjectId,
	workspaceId: ObjectId,
): { _id: ObjectId; workspace_id: ObjectId } => {
	const id = resourceId instanceof ObjectId ? resourceId : new ObjectId(resourceId.toString());

	return {
		_id: id,
		workspace_id: workspaceId,
	};
};

/**
 * Standard Mongo filter for tenant-scoped user lookups by id.
 * @param {string | ObjectId} userId - The user id
 * @param {ObjectId} workspaceId - The workspace id
 * @return {Object} The filter object
*/
export const tenantUserIdFilter = (
	userId: string | ObjectId,
	workspaceId: ObjectId,
): { _id: ObjectId; workspaceId: ObjectId } => {
	const id = userId instanceof ObjectId ? userId : new ObjectId(userId.toString());

	return {
		_id: id,
		workspaceId,
	};
};

export const isWorkspaceAdmin = (cognitoGroups: string[]): boolean => cognitoGroups.includes('admin');

export const READ_ONLY_MESSAGE = 'Your access to this workspace is read-only';

type MemberAccess = Pick<AuthenticatedUserContext, 'userType' | 'isManager'>;

export const canEditWorkspaceData = ({ userType }: Pick<MemberAccess, 'userType'>): boolean =>
	!!userType && EDITOR_USER_TYPES.includes(userType);

export const canManageBilling = ({ userType, isManager }: MemberAccess): boolean =>
	userType === 'admin' || isManager;
