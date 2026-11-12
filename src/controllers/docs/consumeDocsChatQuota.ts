import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

export const DOCS_CHAT_USAGE_COLLECTION = 'docsChatUsage';
const DOCS_CHAT_DAILY_USER_LIMIT = 10;
const DOCS_CHAT_DAILY_WORKSPACE_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Counts one docs chat prompt against the caller's daily user and workspace limits.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Remaining prompts, or 429 when a limit is reached
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context } = tenantResult;

		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		const resetsAt = new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS;
		const expiresAt = new Date(resetsAt + DAY_MS);
		const usage = (await getDb()).collection<{ _id: string; count: number; expiresAt: Date }>(DOCS_CHAT_USAGE_COLLECTION);
		const bump = async (id: string, delta: 1 | -1) => (await usage.findOneAndUpdate(
			{ _id: id },
			{ $inc: { count: delta }, $setOnInsert: { expiresAt } },
			{ upsert: true, returnDocument: 'after' },
		))?.count ?? 0;
		const limited = () => ResponseWrapper.tooManyRequests('Daily docs chat limit reached. It resets tomorrow.', {
			resetsAt: new Date(resetsAt).toISOString(),
		});

		const userKey = `user:${context.userId.toString()}:${day}`;
		const userCount = await bump(userKey, 1);
		if (userCount > DOCS_CHAT_DAILY_USER_LIMIT) {
			await bump(userKey, -1);
			return limited();
		}

		const workspaceKey = `ws:${context.workspaceId.toString()}:${day}`;
		const workspaceCount = await bump(workspaceKey, 1).catch(async (error) => {
			await bump(userKey, -1);
			throw error;
		});
		if (workspaceCount > DOCS_CHAT_DAILY_WORKSPACE_LIMIT) {
			await bump(workspaceKey, -1);
			await bump(userKey, -1);
			return limited();
		}

		return ResponseWrapper.success({
			message: 'Docs chat prompt counted',
			result: { remaining: DOCS_CHAT_DAILY_USER_LIMIT - userCount, resetsAt: new Date(resetsAt).toISOString() },
		});
	} catch (error) {
		logError('Failed to count docs chat prompt', error);
		return ResponseWrapper.internalServerError('Failed to check the docs chat limit');
	}
});
