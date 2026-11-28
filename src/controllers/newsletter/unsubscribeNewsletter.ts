import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { unsubscribeSubscriber } from '../../utils/newsletter/db';
import { getHeader, isNewsletterOriginAllowed, parseJsonBody } from '../../utils/newsletter/request';
import { getNewsletterTokenSecret, verifyNewsletterToken } from '../../utils/newsletter/tokens';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { withTelemetry } from '../../utils/telemetry';

const MAX_FORM_BODY_BYTES = 4 * 1024;

const extractToken = (
	event: APIGatewayProxyEvent,
): { ok: true; token: string; isOneClick: boolean } | { ok: false; response: APIGatewayProxyResult } => {
	const contentType = getHeader(event.headers, 'content-type').toLowerCase();
	const queryToken = event.queryStringParameters?.token?.trim() ?? '';

	if (contentType.startsWith('application/json')) {
		if (!isNewsletterOriginAllowed(event)) {
			return { ok: false, response: ResponseWrapper.forbidden('Origin not allowed.') };
		}
		const parsed = parseJsonBody(event);
		if (!parsed.ok) return parsed;
		const bodyToken = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : '';
		const token = bodyToken || queryToken;
		if (!token) {
			return { ok: false, response: ResponseWrapper.badRequest('Unsubscribe token is required.') };
		}
		return { ok: true, token, isOneClick: false };
	}

	const rawBody = event.body
		? event.isBase64Encoded
			? Buffer.from(event.body, 'base64').toString('utf8')
			: event.body
		: '';
	if (Buffer.byteLength(rawBody, 'utf8') > MAX_FORM_BODY_BYTES) {
		return { ok: false, response: ResponseWrapper.badRequest('Request payload is too large.') };
	}

	const formParams = new URLSearchParams(rawBody);
	const token = queryToken || formParams.get('token')?.trim() || '';
	if (!token) {
		return { ok: false, response: ResponseWrapper.badRequest('Unsubscribe token is required.') };
	}

	return { ok: true, token, isOneClick: true };
};

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const extracted = extractToken(event);
		if (!extracted.ok) return extracted.response;

		const secret = await getNewsletterTokenSecret();
		if (!secret) {
			logError('Newsletter token secret is not configured', new Error('Missing newsletter token secret'));
			return ResponseWrapper.internalServerError('Unable to process unsubscribe request right now.');
		}

		const verified = verifyNewsletterToken(extracted.token, 'unsubscribe', secret);
		if (!verified.ok) {
			return ResponseWrapper.badRequest('This unsubscribe link is invalid.');
		}

		await unsubscribeSubscriber(verified.email, new Date().toISOString());

		return ResponseWrapper.success({
			status: 'unsubscribed',
			message: 'You have been unsubscribed from the Uprevit blog.',
		});
	} catch (error) {
		logError('Failed to process newsletter unsubscribe', error);
		return ResponseWrapper.internalServerError('Unable to process unsubscribe right now. Please try again later.');
	}
});
