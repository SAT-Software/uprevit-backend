import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { confirmSubscriber, getSubscriber } from '../../utils/newsletter/db';
import { isNewsletterOriginAllowed, parseJsonBody } from '../../utils/newsletter/request';
import { getNewsletterTokenSecret, safeEqualString, sha256Hex, verifyNewsletterToken } from '../../utils/newsletter/tokens';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { withTelemetry } from '../../utils/telemetry';

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!isNewsletterOriginAllowed(event)) {
			return ResponseWrapper.forbidden('Origin not allowed.');
		}

		const parsed = parseJsonBody(event);
		if (!parsed.ok) return parsed.response;

		const token = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : '';
		if (!token) {
			return ResponseWrapper.badRequest('Confirmation token is required.');
		}

		const secret = await getNewsletterTokenSecret();
		if (!secret) {
			logError('Newsletter token secret is not configured', new Error('Missing newsletter token secret'));
			return ResponseWrapper.internalServerError('Unable to confirm subscription right now.');
		}

		const verified = verifyNewsletterToken(token, 'confirm', secret);
		if (!verified.ok) {
			const message =
				verified.reason === 'expired'
					? 'This confirmation link has expired. Please subscribe again.'
					: 'This confirmation link is invalid. Please subscribe again.';
			return ResponseWrapper.badRequest(message);
		}

		const subscriber = await getSubscriber(verified.email);
		if (!subscriber) {
			return ResponseWrapper.badRequest('This confirmation link is invalid. Please subscribe again.');
		}

		if (subscriber.status === 'subscribed') {
			return ResponseWrapper.success({
				status: 'already_subscribed',
				message: 'Your subscription is already confirmed.',
			});
		}

		if (subscriber.status === 'bounced' || subscriber.status === 'complained') {
			return ResponseWrapper.badRequest('This email address cannot be subscribed automatically. Please contact support.');
		}

		const expectedHash = subscriber.confirmTokenHash;
		const expiresAtMs = subscriber.confirmTokenExpiresAt ? Date.parse(subscriber.confirmTokenExpiresAt) : NaN;
		if (
			subscriber.status !== 'pending' ||
			!expectedHash ||
			!Number.isFinite(expiresAtMs) ||
			Date.now() > expiresAtMs ||
			!safeEqualString(sha256Hex(token), expectedHash)
		) {
			return ResponseWrapper.badRequest('This confirmation link is invalid or has expired. Please subscribe again.');
		}

		await confirmSubscriber(verified.email, new Date().toISOString());

		return ResponseWrapper.success({
			status: 'confirmed',
			message: 'You are subscribed to the Uprevit blog.',
		});
	} catch (error) {
		logError('Failed to confirm newsletter subscription', error);
		return ResponseWrapper.internalServerError('Unable to confirm subscription right now. Please try again later.');
	}
});
