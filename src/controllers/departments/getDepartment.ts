import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { enrichDepartmentsWithImageUrls, enrichUsersWithProfileAvatarUrls } from '../../utils/s3-storage';

type DepartmentUser = {
	_id: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
};

type DepartmentWithUsers = Omit<Department, 'users'> & {
	users?: DepartmentUser[];
	auditLogs?: unknown[];
	actionAt?: Date;
};

/**
 * Get a department
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
		const db = await getDb();
		
		const departmentData = await db.collection<Department>('departments').aggregate<DepartmentWithUsers>([
			{
				$match: {
					_id: new ObjectId(event.pathParameters.id),
					workspace_id: context.workspaceId,
					isArchived: { $ne: true },
				},
			},
			{
				$lookup: {
					from: 'users',
					localField: 'users',
					foreignField: '_id',
					pipeline: [
						{
							$project: {
								_id: 1,
								name: 1,
								email: 1,
								profileAvatar: 1,
							},
						},
					],
					as: 'users',
				},
			},
			buildLegacyAuditLookupStage({
				scopeType: 'department',
				updateActions: ['update', 'restore'],
			})
		]).toArray();

		const department = departmentData[0];

		if (!department) {
			return ResponseWrapper.badRequest('Department not found');
		}

		const signingOptions = {
			workspaceId: context.workspaceId,
			pendingOwnerId: context.cognitoSub,
		};

		const usersWithSignedAvatars = department.users?.length
			? await enrichUsersWithProfileAvatarUrls(department.users, signingOptions)
			: department.users;

		const [departmentWithSignedImage] = await enrichDepartmentsWithImageUrls([
			{
				...department,
				users: usersWithSignedAvatars,
			},
		], signingOptions);

		return ResponseWrapper.success({
			message: 'Department retrieved successfully',
			department: departmentWithSignedImage,
		});
		
	} catch (err) {
		logError('Get department handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get department');
	}
}; 
