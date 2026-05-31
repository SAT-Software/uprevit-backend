import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';
import { requireTenantContext, tenantUserIdFilter } from '../../utils/tenantContext';
import { validateAllObjectIds } from '../../utils/validationUtils';

/**
 * Get a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const objectIdValidation = validateAllObjectIds({ id: event.pathParameters.id });
		if (objectIdValidation) return objectIdValidation;

		const db = await getDb();

		const user = await db.collection<User>('users').findOne(
			tenantUserIdFilter(event.pathParameters.id, context.workspaceId),
		);

		if (!user) {
			return ResponseWrapper.notFound('User not found');
		}

		const [userWithSignedAvatar] = await enrichUsersWithProfileAvatarUrls([user], {
			workspaceId: context.workspaceId,
			pendingOwnerId: context.cognitoSub,
		});

		return ResponseWrapper.success({
			message: 'User retrieved successfully',
			user: userWithSignedAvatar ?? user,
		});

	} catch (err) {
		logError('Get user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get user');
	}
};
