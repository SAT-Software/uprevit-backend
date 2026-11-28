import crypto from 'node:crypto';
import { readSecureParameter } from '../ssm';

export const CONFIRM_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

export type NewsletterTokenAction = 'confirm' | 'unsubscribe';

interface TokenPayload {
	a: NewsletterTokenAction;
	e: string;
	n?: string;
	exp?: number;
}

export const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const safeEqualString = (a: string, b: string): boolean => {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
};

const signPayload = (encodedPayload: string, secret: string): string =>
	crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');

const encodeToken = (payload: TokenPayload, secret: string): string => {
	const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	return `${encoded}.${signPayload(encoded, secret)}`;
};

export const createConfirmToken = (
	email: string,
	secret: string,
	nowMs = Date.now(),
): { token: string; tokenHash: string; expiresAt: string } => {
	const normalizedEmail = email.trim().toLowerCase();
	const expiresAtMs = nowMs + CONFIRM_TOKEN_TTL_MS;
	const token = encodeToken(
		{
			a: 'confirm',
			e: normalizedEmail,
			n: crypto.randomBytes(16).toString('hex'),
			exp: expiresAtMs,
		},
		secret,
	);
	return {
		token,
		tokenHash: sha256Hex(token),
		expiresAt: new Date(expiresAtMs).toISOString(),
	};
};

export const createUnsubscribeToken = (email: string, secret: string): string =>
	encodeToken(
		{
			a: 'unsubscribe',
			e: email.trim().toLowerCase(),
		},
		secret,
	);

export const verifyNewsletterToken = (
	token: string,
	expectedAction: NewsletterTokenAction,
	secret: string,
	nowMs = Date.now(),
): { ok: true; email: string } | { ok: false; reason: 'invalid' | 'expired' } => {
	if (!token || !secret || token.length > 1024) {
		return { ok: false, reason: 'invalid' };
	}

	const parts = token.split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return { ok: false, reason: 'invalid' };
	}

	const [encoded, signature] = parts;
	const expectedSig = signPayload(encoded, secret);
	if (!safeEqualString(signature, expectedSig)) {
		return { ok: false, reason: 'invalid' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'invalid' };
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'invalid' };
	}

	const payload = parsed as Partial<TokenPayload>;
	if (payload.a !== expectedAction || typeof payload.e !== 'string' || !payload.e.trim()) {
		return { ok: false, reason: 'invalid' };
	}

	if (expectedAction === 'confirm') {
		if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
			return { ok: false, reason: 'invalid' };
		}
		if (nowMs > payload.exp) {
			return { ok: false, reason: 'expired' };
		}
	}

	return { ok: true, email: payload.e.trim().toLowerCase() };
};

export const getNewsletterTokenSecret = async (): Promise<string> => {
	const paramName = process.env.NEWSLETTER_TOKEN_SECRET_PARAM?.trim();
	if (paramName) {
		return readSecureParameter(paramName);
	}
	return process.env.NEWSLETTER_TOKEN_SECRET?.trim() ?? '';
};
