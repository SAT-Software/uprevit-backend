import { PostHog } from 'posthog-node';

const { POSTHOG_PROJECT_TOKEN, POSTHOG_HOST, AWS_LAMBDA_FUNCTION_NAME } = process.env;

const client = POSTHOG_PROJECT_TOKEN
	? new PostHog(POSTHOG_PROJECT_TOKEN, { host: POSTHOG_HOST || 'https://us.i.posthog.com', requestTimeout: 5000, fetchRetryCount: 0 })
	: null;
const pending = new Set<Promise<void>>();

const stringOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Sends an error to PostHog error tracking with only pseudonymous context; no-op when PostHog is not configured.
 * @param {string} message Human-readable error message
 * @param {unknown} error The error to capture
 * @param {Record<string, unknown>} context Log context; only userId and workspaceId are forwarded
 */
export function captureError(message: string, error: unknown, context: Record<string, unknown> = {}): void {
	if (!client) return;

	const capture = client
		.captureExceptionImmediate(error, stringOrUndefined(context.userId), {
			source: 'lambda',
			message,
			functionName: AWS_LAMBDA_FUNCTION_NAME,
			workspaceId: stringOrUndefined(context.workspaceId),
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
		try {
			return await handler(...args);
		} finally {
			await Promise.all(pending);
		}
	};
