import { ObjectId } from 'mongodb';
import { PostHog } from 'posthog-node';

const { POSTHOG_PROJECT_TOKEN, POSTHOG_HOST, AWS_LAMBDA_FUNCTION_NAME } = process.env;

const client = POSTHOG_PROJECT_TOKEN
	? new PostHog(POSTHOG_PROJECT_TOKEN, { host: POSTHOG_HOST || 'https://us.i.posthog.com', requestTimeout: 5000, fetchRetryCount: 0 })
	: null;
const pending = new Set<Promise<void>>();
let requestIdentity: { userId?: string; workspaceId?: string } = {};

const toId = (value: unknown): string | undefined => {
	if (value instanceof ObjectId) return value.toHexString();
	return typeof value === 'string' && value ? value : undefined;
};

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

const redactText = (text: string): string => text.slice(0, 2000).replace(EMAIL_PATTERN, '[email]');

const redactEmails = (error: unknown): unknown => {
	if (!(error instanceof Error)) return typeof error === 'string' ? redactText(error) : error;
	const safe = new Error(redactText(error.message));
	safe.name = error.name;
	const frames = error.stack?.split('\n').filter((line) => line.trimStart().startsWith('at ')) ?? [];
	safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join('\n');
	return safe;
};

/**
 * Remembers the verified user and workspace for errors captured during the current invocation.
 * @param {unknown} userId User ID
 * @param {unknown} workspaceId Workspace ID
 */
export function setTelemetryIdentity(userId: unknown, workspaceId: unknown): void {
	requestIdentity = { userId: toId(userId), workspaceId: toId(workspaceId) };
}

/**
 * Sends an error to PostHog error tracking with only pseudonymous context; no-op when PostHog is not configured.
 * @param {string} message Human-readable error message
 * @param {unknown} error The error to capture
 * @param {Record<string, unknown>} context Log context; only userId and workspaceId are forwarded
 */
export function captureError(message: string, error: unknown, context: Record<string, unknown> = {}): void {
	if (!client) return;

	const capture = client
		.captureExceptionImmediate(redactEmails(error), toId(context.userId) ?? requestIdentity.userId, {
			source: 'lambda',
			message,
			functionName: AWS_LAMBDA_FUNCTION_NAME,
			workspaceId: toId(context.workspaceId) ?? requestIdentity.workspaceId,
		})
		.catch(() => undefined)
		.finally(() => pending.delete(capture));
	pending.add(capture);
}

/**
 * Wraps a Lambda handler so captured errors are delivered before the execution environment freezes.
 * @param {Function} handler Lambda handler
 * @return {Function} Wrapped handler
 */
export const withTelemetry = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => Promise<TResult>) =>
	async (...args: TArgs): Promise<TResult> => {
		requestIdentity = {};
		try {
			return await handler(...args);
		} finally {
			await Promise.all(pending);
		}
	};
