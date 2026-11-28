import crypto from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError, logWarn } from '../logger';
import { ResponseWrapper } from '../responseWrapper';
import { readSecureParameter } from '../ssm';

const MAX_BODY_BYTES = 4 * 1024;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINE_BREAK_REGEX = /[\r\n]/;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

interface TurnstileVerifyResponse {
	success?: boolean;
	'error-codes'?: string[];
}

export const getHeader = (headers: APIGatewayProxyEvent['headers'], name: string): string => {
	if (!headers) return '';
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === 'string') {
			return value.trim();
		}
	}
	return '';
};

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();

export const getRequestOrigin = (event: APIGatewayProxyEvent): string => {
	const origin = getHeader(event.headers, 'origin');
	if (origin) return normalizeOrigin(origin);

	const referer = getHeader(event.headers, 'referer');
	if (!referer) return '';
	try {
		return normalizeOrigin(new URL(referer).origin);
	} catch {
		return '';
	}
};

export const isNewsletterOriginAllowed = (event: APIGatewayProxyEvent): boolean => {
	const raw = process.env.NEWSLETTER_ALLOWED_ORIGINS?.trim() || process.env.CONTACT_ALLOWED_ORIGINS?.trim() || '';
	const configured = raw
		.split(',')
		.map(normalizeOrigin)
		.filter(Boolean);
	const requestOrigin = getRequestOrigin(event);

	if (configured.length > 0) {
		return Boolean(requestOrigin && configured.includes(requestOrigin));
	}

	if (process.env.DB_NAME !== 'uprevit-test') {
		return false;
	}

	if (!requestOrigin) return true;
	return (
		requestOrigin === 'https://dev.uprevit.com' ||
		requestOrigin.startsWith('http://localhost:') ||
		requestOrigin.startsWith('http://127.0.0.1:')
	);
};

export const getClientIp = (event: APIGatewayProxyEvent): string => {
	const sourceIp = event.requestContext?.identity?.sourceIp?.trim();
	if (sourceIp) return sourceIp;

	const xff = getHeader(event.headers, 'x-forwarded-for');
	if (xff) {
		const parts = xff
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length > 0) return parts[parts.length - 1];
	}

	return 'unknown';
};

export const hashRateLimitKey = (value: string): string =>
	crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

export const parseJsonBody = (
	event: APIGatewayProxyEvent,
): { ok: true; data: Record<string, unknown> } | { ok: false; response: APIGatewayProxyResult } => {
	if (!event.body) {
		return { ok: false, response: ResponseWrapper.badRequest('Request body is required.') };
	}

	const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
	if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
		return { ok: false, response: ResponseWrapper.badRequest('Request payload is too large.') };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, response: ResponseWrapper.badRequest('Invalid JSON request body.') };
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, response: ResponseWrapper.badRequest('Invalid request payload.') };
	}

	return { ok: true, data: parsed as Record<string, unknown> };
};

export const normalizeAndValidateEmail = (
	raw: unknown,
): { ok: true; email: string; normalizedEmail: string } | { ok: false; message: string } => {
	if (typeof raw !== 'string') {
		return { ok: false, message: 'Enter your work email.' };
	}
	const email = raw.trim();
	if (!email) {
		return { ok: false, message: 'Enter your work email.' };
	}
	if (email.length > 254 || LINE_BREAK_REGEX.test(email) || !EMAIL_REGEX.test(email)) {
		return { ok: false, message: 'Enter a valid email address.' };
	}
	return { ok: true, email, normalizedEmail: email.toLowerCase() };
};

export const rateLimitedResponse = (resetsAtMs: number): APIGatewayProxyResult => {
	const retryAfterSeconds = Math.max(1, Math.ceil((resetsAtMs - Date.now()) / 1000));
	const response = ResponseWrapper.tooManyRequests('Too many requests recently. Please try again later.', {
		resetsAt: new Date(resetsAtMs).toISOString(),
	});
	response.headers = { ...response.headers, 'Retry-After': String(retryAfterSeconds) };
	return response;
};

export const verifyNewsletterTurnstile = async (
	token: string,
	remoteIp: string,
): Promise<{ ok: true } | { ok: false; status: 'missing' | 'failed' | 'misconfigured' | 'unavailable' }> => {
	const secretParam = process.env.NEWSLETTER_TURNSTILE_SECRET_PARAM?.trim();
	if (!secretParam) {
		if (process.env.DB_NAME === 'uprevit-test') {
			logWarn('Newsletter Turnstile verification skipped in dev because NEWSLETTER_TURNSTILE_SECRET_PARAM is not set');
			return { ok: true };
		}
		logError('Newsletter Turnstile secret parameter is not configured', new Error('Missing NEWSLETTER_TURNSTILE_SECRET_PARAM'));
		return { ok: false, status: 'misconfigured' };
	}

	if (!token) {
		return { ok: false, status: 'missing' };
	}

	const secret = await readSecureParameter(secretParam);
	if (!secret) {
		logError('Newsletter Turnstile secret parameter is empty or missing in SSM', new Error('Empty Turnstile secret'), {
			secretParam,
		});
		return { ok: false, status: 'misconfigured' };
	}

	const form = new URLSearchParams({ secret, response: token });
	if (remoteIp && remoteIp !== 'unknown') {
		form.set('remoteip', remoteIp);
	}

	try {
		const res = await fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
			signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
		});

		if (!res.ok) {
			logWarn('Newsletter Turnstile verification HTTP failure', { status: res.status });
			return { ok: false, status: 'failed' };
		}

		const outcome = (await res.json()) as TurnstileVerifyResponse;
		if (!outcome.success) {
			logWarn('Newsletter Turnstile verification rejected', { errorCodes: outcome['error-codes'] ?? [] });
			return { ok: false, status: 'failed' };
		}

		return { ok: true };
	} catch (error) {
		logError('Newsletter Turnstile verification request failed', error);
		return { ok: false, status: 'unavailable' };
	}
};

export const getNewsletterSiteBaseUrl = (event?: APIGatewayProxyEvent): string => {
	const configured = process.env.NEWSLETTER_SITE_BASE_URL?.trim().replace(/\/+$/, '');
	if (configured) return configured;

	if (process.env.DB_NAME === 'uprevit-test') {
		const origin = event ? getRequestOrigin(event) : '';
		if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
			return origin;
		}
		return 'https://dev.uprevit.com';
	}

	return 'https://www.uprevit.com';
};

export const getNewsletterFromAddress = (): string =>
	process.env.NEWSLETTER_FROM_ADDRESS?.trim() || 'Uprevit Blog <blog@updates.uprevit.com>';

export const getNewsletterReplyToAddress = (): string =>
	process.env.NEWSLETTER_REPLY_TO_ADDRESS?.trim() || 'contact@uprevit.com';

export const getNewsletterPhysicalAddress = (): string | undefined => {
	const value = process.env.NEWSLETTER_PHYSICAL_ADDRESS?.trim();
	return value || undefined;
};
