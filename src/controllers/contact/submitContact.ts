import crypto from 'node:crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { sendEmail } from '../../utils/email';
import { logError, logWarn } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { readSecureParameter } from '../../utils/ssm';
import { withTelemetry } from '../../utils/telemetry';

export const CONTACT_RATE_LIMITS_COLLECTION = 'contactRateLimits';

const MAX_BODY_BYTES = 16 * 1024;
const IP_LIMIT = 3;
const IP_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_LIMIT = 3;
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const TTL_BUFFER_MS = 60 * 1000;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINE_BREAK_REGEX = /[\r\n]/;

const TOPIC_LABELS = {
	demo: 'Book a demo',
	pricing: 'Pricing',
	support: 'Support',
} as const;

type ContactTopic = keyof typeof TOPIC_LABELS;

interface ValidatedContact {
	firstName: string;
	lastName: string;
	email: string;
	normalizedEmail: string;
	company: string;
	topic: ContactTopic;
	topicLabel: string;
	message: string;
	turnstileToken: string;
}

interface TurnstileVerifyResponse {
	success?: boolean;
	'error-codes'?: string[];
}

let hasEnsuredRateLimitIndex = false;

export const resetContactRateLimitIndexFlagForTests = () => {
	hasEnsuredRateLimitIndex = false;
};

const getHeader = (headers: APIGatewayProxyEvent['headers'], name: string): string => {
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

const getRequestOrigin = (event: APIGatewayProxyEvent): string => {
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

const isOriginAllowed = (event: APIGatewayProxyEvent): boolean => {
	const configured = (process.env.CONTACT_ALLOWED_ORIGINS ?? '')
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
	return requestOrigin === 'https://dev.uprevit.com' || requestOrigin.startsWith('http://localhost:') || requestOrigin.startsWith('http://127.0.0.1:');
};

const getClientIp = (event: APIGatewayProxyEvent): string => {
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

const hashKey = (value: string): string => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

const parseBody = (event: APIGatewayProxyEvent): { ok: true; data: Record<string, unknown> } | { ok: false; response: APIGatewayProxyResult } => {
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

const validateContact = (
	payload: Record<string, unknown>,
): { ok: true; value: ValidatedContact } | { ok: false; response: APIGatewayProxyResult } => {
	const errors: Record<string, string> = {};

	const readString = (key: string): string | null => {
		const raw = payload[key];
		if (raw === undefined || raw === null) return '';
		return typeof raw === 'string' ? raw : null;
	};

	const rawFirstName = readString('firstName');
	const firstName = rawFirstName?.trim() ?? '';
	if (rawFirstName === null || !firstName) {
		errors.firstName = 'Enter your first name.';
	} else if (firstName.length > 80 || LINE_BREAK_REGEX.test(firstName)) {
		errors.firstName = 'First name must be 80 characters or fewer.';
	}

	const rawLastName = readString('lastName');
	const lastName = rawLastName?.trim() ?? '';
	if (rawLastName === null || !lastName) {
		errors.lastName = 'Enter your last name.';
	} else if (lastName.length > 80 || LINE_BREAK_REGEX.test(lastName)) {
		errors.lastName = 'Last name must be 80 characters or fewer.';
	}

	const rawEmail = readString('email');
	const email = rawEmail?.trim() ?? '';
	if (rawEmail === null || !email) {
		errors.email = 'Enter your work email.';
	} else if (email.length > 254 || LINE_BREAK_REGEX.test(email) || !EMAIL_REGEX.test(email)) {
		errors.email = 'Enter a valid email address.';
	}

	const rawCompany = readString('company');
	const company = rawCompany?.trim() ?? '';
	if (rawCompany === null || !company) {
		errors.company = 'Enter your company name.';
	} else if (company.length > 120 || LINE_BREAK_REGEX.test(company)) {
		errors.company = 'Company name must be 120 characters or fewer.';
	}

	const rawTopic = readString('topic');
	const topic = rawTopic?.trim() ?? '';
	if (rawTopic === null || !(topic in TOPIC_LABELS)) {
		errors.topic = 'Select a valid topic.';
	}

	const rawMessage = readString('message');
	const message = rawMessage ? rawMessage.replace(/\r\n/g, '\n').trim() : '';
	if (rawMessage === null) {
		errors.message = 'Message must be text.';
	} else if (message.length > 2000) {
		errors.message = 'Message must be 2,000 characters or fewer.';
	}

	const rawTurnstileToken = readString('turnstileToken');
	const turnstileToken = rawTurnstileToken?.trim() ?? '';
	if (rawTurnstileToken === null || turnstileToken.length > 4096) {
		errors.turnstileToken = 'Invalid verification token.';
	}

	const firstError = Object.values(errors)[0];
	if (firstError) {
		return { ok: false, response: ResponseWrapper.badRequest(firstError, { errors }) };
	}

	const validatedTopic = topic as ContactTopic;
	return {
		ok: true,
		value: {
			firstName,
			lastName,
			email,
			normalizedEmail: email.toLowerCase(),
			company,
			topic: validatedTopic,
			topicLabel: TOPIC_LABELS[validatedTopic],
			message,
			turnstileToken,
		},
	};
};

const rateLimitedResponse = (resetsAtMs: number): APIGatewayProxyResult => {
	const retryAfterSeconds = Math.max(1, Math.ceil((resetsAtMs - Date.now()) / 1000));
	const response = ResponseWrapper.tooManyRequests('Too many messages sent recently. Please try again later.', {
		resetsAt: new Date(resetsAtMs).toISOString(),
	});
	response.headers = { ...response.headers, 'Retry-After': String(retryAfterSeconds) };
	return response;
};

const verifyTurnstile = async (
	token: string,
	remoteIp: string,
): Promise<{ ok: true } | { ok: false; status: 'missing' | 'failed' | 'misconfigured' | 'unavailable' }> => {
	const secretParam = process.env.TURNSTILE_SECRET_PARAM?.trim();
	if (!secretParam) {
		if (process.env.DB_NAME === 'uprevit-test') {
			logWarn('Turnstile verification skipped in dev because TURNSTILE_SECRET_PARAM is not set');
			return { ok: true };
		}
		logError('Turnstile secret parameter is not configured', new Error('Missing TURNSTILE_SECRET_PARAM'));
		return { ok: false, status: 'misconfigured' };
	}

	if (!token) {
		return { ok: false, status: 'missing' };
	}

	const secret = await readSecureParameter(secretParam);
	if (!secret) {
		logError('Turnstile secret parameter is empty or missing in SSM', new Error('Empty Turnstile secret'), { secretParam });
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
			logWarn('Turnstile verification HTTP failure', { status: res.status });
			return { ok: false, status: 'failed' };
		}

		const outcome = (await res.json()) as TurnstileVerifyResponse;
		if (!outcome.success) {
			logWarn('Turnstile verification rejected', { errorCodes: outcome['error-codes'] ?? [] });
			return { ok: false, status: 'failed' };
		}

		return { ok: true };
	} catch (error) {
		logError('Turnstile verification request failed', error);
		return { ok: false, status: 'unavailable' };
	}
};

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!isOriginAllowed(event)) {
			return ResponseWrapper.forbidden('Origin not allowed.');
		}

		const parsed = parseBody(event);
		if (!parsed.ok) return parsed.response;

		const honeypot = parsed.data.website;
		if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
			logWarn('Contact form honeypot triggered');
			return ResponseWrapper.success({ message: 'Message sent' });
		}

		const validated = validateContact(parsed.data);
		if (!validated.ok) return validated.response;
		const contact = validated.value;

		const nowMs = Date.now();
		const ipBucket = Math.floor(nowMs / IP_WINDOW_MS);
		const ipResetsAtMs = (ipBucket + 1) * IP_WINDOW_MS;
		const ipExpiresAt = new Date(ipResetsAtMs + TTL_BUFFER_MS);

		const emailBucket = Math.floor(nowMs / EMAIL_WINDOW_MS);
		const emailResetsAtMs = (emailBucket + 1) * EMAIL_WINDOW_MS;
		const emailExpiresAt = new Date(emailResetsAtMs + TTL_BUFFER_MS);

		const limits = (await getDb()).collection<{ _id: string; count: number; expiresAt: Date }>(CONTACT_RATE_LIMITS_COLLECTION);
		if (!hasEnsuredRateLimitIndex) {
			await limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
			hasEnsuredRateLimitIndex = true;
		}

		const bump = async (id: string, delta: 1 | -1, expiresAt: Date) =>
			(
				await limits.findOneAndUpdate(
					{ _id: id },
					{ $inc: { count: delta }, $setOnInsert: { expiresAt } },
					{ upsert: true, returnDocument: 'after' },
				)
			)?.count ?? 0;

		const clientIp = getClientIp(event);
		const ipKey = `ip:${hashKey(clientIp)}:${ipBucket}`;
		const ipCount = await bump(ipKey, 1, ipExpiresAt);
		if (ipCount > IP_LIMIT) {
			await bump(ipKey, -1, ipExpiresAt);
			return rateLimitedResponse(ipResetsAtMs);
		}

		const verification = await verifyTurnstile(contact.turnstileToken, clientIp).catch(async (error) => {
			await bump(ipKey, -1, ipExpiresAt).catch(() => undefined);
			throw error;
		});

		if (!verification.ok) {
			if (verification.status !== 'failed') {
				await bump(ipKey, -1, ipExpiresAt).catch(() => undefined);
			}
			if (verification.status === 'missing') {
				return ResponseWrapper.badRequest('Please complete the verification check and try again.');
			}
			if (verification.status === 'failed') {
				return ResponseWrapper.forbidden('Verification failed. Please refresh and try again.');
			}
			return ResponseWrapper.internalServerError('Verification service is temporarily unavailable. Please try again.');
		}

		const emailKey = `email:${hashKey(contact.normalizedEmail)}:${emailBucket}`;
		const emailCount = await bump(emailKey, 1, emailExpiresAt).catch(async (error) => {
			await bump(ipKey, -1, ipExpiresAt).catch(() => undefined);
			throw error;
		});
		if (emailCount > EMAIL_LIMIT) {
			await bump(emailKey, -1, emailExpiresAt);
			await bump(ipKey, -1, ipExpiresAt);
			return rateLimitedResponse(emailResetsAtMs);
		}

		const to = process.env.CONTACT_TO_EMAIL?.trim() || 'contact@uprevit.com';
		const submittedAt = new Date(nowMs).toISOString();

		try {
			const sent = await sendEmail({
				to,
				replyTo: contact.email,
				subject: `[${contact.topicLabel}] ${contact.company} — ${contact.firstName} ${contact.lastName}`,
				title: `New ${contact.topicLabel.toLowerCase()} inquiry`,
				fields: [
					{ label: 'Topic', value: contact.topicLabel },
					{ label: 'Name', value: `${contact.firstName} ${contact.lastName}` },
					{ label: 'Work email', value: contact.email },
					{ label: 'Company', value: contact.company },
					{ label: 'Submitted', value: submittedAt },
				],
				body: contact.message || undefined,
				footer: 'Sent from the Uprevit website contact form. Reply directly to respond to the sender.',
			});

			if (!sent) {
				await bump(emailKey, -1, emailExpiresAt).catch(() => undefined);
				await bump(ipKey, -1, ipExpiresAt).catch(() => undefined);
				logError('Contact email could not be sent because SES_FROM_ADDRESS is not configured', new Error('Missing SES_FROM_ADDRESS'));
				return ResponseWrapper.internalServerError('Unable to send message right now. Please try again later.');
			}
		} catch (error) {
			await bump(emailKey, -1, emailExpiresAt).catch(() => undefined);
			await bump(ipKey, -1, ipExpiresAt).catch(() => undefined);
			logError('Failed to send contact form email', error);
			return ResponseWrapper.internalServerError('Unable to send message right now. Please try again later.');
		}

		return ResponseWrapper.success({ message: 'Message sent' });
	} catch (error) {
		logError('Failed to process contact form submission', error);
		return ResponseWrapper.internalServerError('Unable to send message right now. Please try again later.');
	}
});
