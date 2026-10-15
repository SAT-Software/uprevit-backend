import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import crypto from 'node:crypto';
import { authenticateRequest } from './authUtils';
import { ResponseWrapper } from './responseWrapper';

const SSM_CACHE_TTL_MS = 5 * 60 * 1000;
const REVIEWER_FORBIDDEN_MESSAGE = 'You are not allowed to view support attachments';

const ssm = new SSMClient({});
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ssmCache = new Map<string, { value: string; expiresAt: number }>();

const readSecureParameter = async (name: string | undefined): Promise<string> => {
	const parameterName = name?.trim();
	if (!parameterName) return '';

	const cached = ssmCache.get(parameterName);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	let value = '';
	try {
		const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
		value = response.Parameter?.Value?.trim() ?? '';
	} catch (error) {
		if (!(error instanceof ParameterNotFound)) throw error;
	}

	ssmCache.set(parameterName, { value, expiresAt: Date.now() + SSM_CACHE_TTL_MS });
	return value;
};

export const normalizeSupportEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Signs the Support identity with the PostHog Support secret, or returns null when the secret is not configured.
 * @param {string} distinctId PostHog distinct ID
 */
export const createSupportIdentityHash = async (distinctId: string): Promise<string | null> => {
	const secret = await readSecureParameter(process.env.POSTHOG_SUPPORT_SECRET_PARAM);
	if (!secret) return null;
	return crypto.createHmac('sha256', secret).update(distinctId).digest('hex');
};

const getSupportReviewerEmails = async (): Promise<Set<string>> => {
	const raw = await readSecureParameter(process.env.SUPPORT_REVIEWER_EMAILS_PARAM);
	return new Set(raw.split(',').map(normalizeSupportEmail).filter(Boolean));
};

/**
 * Allows only Cognito users whose verified email is on the reviewer allowlist. Workspace membership is never consulted.
 * @param {APIGatewayProxyEvent} event API Gateway event
 */
export const requireSupportReviewer = async (
	event: APIGatewayProxyEvent,
): Promise<{ ok: true } | { ok: false; response: APIGatewayProxyResult }> => {
	const auth = await authenticateRequest(event);
	if (!auth.isValid) return { ok: false, response: auth.error };

	const forbidden = { ok: false as const, response: ResponseWrapper.forbidden(REVIEWER_FORBIDDEN_MESSAGE) };
	const { sub, username } = auth.payload;
	if (!sub || !username) return forbidden;

	const reviewerEmails = await getSupportReviewerEmails();
	if (reviewerEmails.size === 0) return forbidden;

	let user;
	try {
		user = await cognito.send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: username }));
	} catch (error) {
		if (error instanceof UserNotFoundException) return forbidden;
		throw error;
	}

	const attributes = new Map((user.UserAttributes ?? []).map((attribute) => [attribute.Name, attribute.Value ?? '']));
	const email = normalizeSupportEmail(attributes.get('email') ?? '');

	if (
		!user.Enabled
		|| attributes.get('sub') !== sub
		|| attributes.get('email_verified') !== 'true'
		|| !email
		|| !reviewerEmails.has(email)
	) {
		return forbidden;
	}

	return { ok: true };
};
