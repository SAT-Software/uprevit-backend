import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Workspace } from '../../models/workspace';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { createSupportIdentityHash } from '../../utils/support';

/**
 * Returns the caller's signed Support identity and whether their workspace opted in to support session replay.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const distinctId = context.userId.toString();

		const db = await getDb();
		const workspace = await db.collection<Workspace>('workspaces').findOne(
			{ _id: context.workspaceId },
			{ projection: { supportReplayEnabled: 1 } },
		);

		return {
			...ResponseWrapper.success({
				message: 'Support config retrieved successfully',
				result: {
					distinctId,
					identityHash: await createSupportIdentityHash(distinctId),
					replayEnabled: workspace?.supportReplayEnabled === true,
				},
			}),
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
		};
	} catch (err) {
		logError('Get support config handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get support config');
	}
};
