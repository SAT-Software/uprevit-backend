import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { timingSafeEqual } from 'crypto';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import {
	getChargebeeWebhookPassword,
	getChargebeeWebhookUsername,
	isChargebeeWebhookConfigured,
} from '../../config/chargebeeConfig';
import type { ChargebeeSubscription } from '../../utils/billing/chargebeeClient';
import {
	applyChargebeeSubscriptionMirror,
	claimChargebeeWebhook,
	findBillingAccountByChargebeeCustomerId,
	findBillingAccountByChargebeeSubscriptionId,
	releaseChargebeeWebhookClaim,
	syncPastDueFromChargebee,
} from '../../utils/billing/chargebeeWebhooks';

const safeCompare = (left: string, right: string): boolean => {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
};

const parseBasicAuth = (header?: string): { username: string; password: string } | null => {
	if (!header?.startsWith('Basic ')) return null;
	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
	const separator = decoded.indexOf(':');
	if (separator < 0) return null;
	return {
		username: decoded.slice(0, separator),
		password: decoded.slice(separator + 1),
	};
};

const isAuthorized = (event: APIGatewayProxyEvent): boolean => {
	if (!isChargebeeWebhookConfigured()) return false;

	const credentials = parseBasicAuth(
		event.headers.authorization ?? event.headers.Authorization,
	);
	if (!credentials) return false;

	return safeCompare(credentials.username, getChargebeeWebhookUsername())
		&& safeCompare(credentials.password, getChargebeeWebhookPassword());
};

const subscriptionFromContent = (content: Record<string, unknown>): ChargebeeSubscription | null => {
	const subscription = content.subscription;
	if (!subscription || typeof subscription !== 'object') return null;
	return subscription as ChargebeeSubscription;
};

/**
 * Processes Chargebee webhook events to mirror subscription terms, seats, and SSO.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Acknowledgement response
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	let eventId: string | undefined;

	try {
		if (!isAuthorized(event)) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		let payload: {
			id?: string;
			event_type?: string;
			content?: Record<string, unknown>;
		};

		try {
			payload = JSON.parse(event.body);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		eventId = payload.id?.trim();
		const eventType = payload.event_type?.trim();
		if (!eventId || !eventType) {
			return ResponseWrapper.badRequest('Invalid webhook payload');
		}

		const claim = await claimChargebeeWebhook(eventId, eventType);
		if (claim === 'duplicate') {
			return ResponseWrapper.success({ message: 'Webhook already processed' });
		}

		const content = payload.content ?? {};
		const subscription = subscriptionFromContent(content);

		if (
			subscription
			&& [
				'subscription_created',
				'subscription_changed',
				'subscription_renewed',
				'subscription_activated',
				'subscription_reactivated',
				'subscription_cancelled',
				'subscription_deleted',
			].includes(eventType)
		) {
			const account = await findBillingAccountByChargebeeSubscriptionId(subscription.id)
				?? (subscription.customer_id
					? await findBillingAccountByChargebeeCustomerId(subscription.customer_id)
					: null);

			if (account) {
				await applyChargebeeSubscriptionMirror({ account, subscription });
			}
		}

		if (eventType === 'invoice_generated' || eventType === 'invoice_updated') {
			const invoice = content.invoice as { subscription_id?: string } | undefined;
			if (invoice?.subscription_id) {
				await syncPastDueFromChargebee(invoice.subscription_id);
			}
		}

		if (eventType === 'payment_succeeded') {
			const invoice = content.invoice as { subscription_id?: string } | undefined;
			if (invoice?.subscription_id) {
				await syncPastDueFromChargebee(invoice.subscription_id);
			}
		}

		return ResponseWrapper.success({ message: 'Webhook processed' });
	} catch (error) {
		if (eventId) {
			await releaseChargebeeWebhookClaim(eventId).catch(() => undefined);
		}
		logError('Chargebee webhook processing failed', error);
		return ResponseWrapper.internalServerError('Failed to process webhook');
	}
};
