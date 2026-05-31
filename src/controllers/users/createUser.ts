import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { User } from '../../models/user';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';

/**
 * Create a user
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: User = JSON.parse(event.body);

		if (!input.name || !input.email || !input.userType) {
			return ResponseWrapper.badRequest('Missing required fields: name, email, and userType are required');
		}

		const db = await getDb();

		const user = await db.collection<User>('users').insertOne({
			name: input.name,
			profileAvatar: normalizePersistedAssetReference(input.profileAvatar, ''),
			designation: input.designation,
			email: input.email,
			phone: input.phone,
			userType: input.userType,
			location: input.location ?? '',
			cognitoSub: '',
			workspaceId: context.workspaceId,
			status: 'invited',
		});

		await updateAuditLog({
			entity: 'user',
			entityId: user.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: context.userId.toString(),
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'User created successfully',
			user: user,
		});

	} catch (err) {
		logError('Create user handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create user');
	}
};
