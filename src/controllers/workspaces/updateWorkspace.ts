import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateWithRole } from '../../utils/authUtils';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';

/**
 * Update a workspace
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateWithRole(event, 'admin');
		
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		let input: Workspace;
		
		try {
			input = JSON.parse(event.body!);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const missingFieldsResult = validateMissingFields({
			'workspaceName': input.workspaceName,
			'_id': input._id!.toString(),
		});
		
		if (missingFieldsResult) {
			return missingFieldsResult;
		}

		const objectIdsResult = validateAllObjectIds({
			'_id': input._id!,
		});

		if (objectIdsResult) {
			return objectIdsResult;
		}

		// Validate user IDs if provided
		if (input.userIds && input.userIds.length > 0) {
			const invalidUserIds = input.userIds.filter((userId) => !ObjectId.isValid(userId));
			if (invalidUserIds.length > 0) {
				return ResponseWrapper.badRequest(
					`Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`,
				);
			}
		}

		const db = await getDb();

		const workspaceRecord: Workspace | null = await db.collection<Workspace>('workspaces').findOne({
			_id: new ObjectId(input._id),
		});

		if (!workspaceRecord) {
			return ResponseWrapper.badRequest('Workspace not found');
		}

		const userObjectIds = input.userIds ? input.userIds.map((userId) => new ObjectId(userId)) : [];

		const workspace = await db.collection<Workspace>('workspaces').updateOne(
			{
				_id: new ObjectId(workspaceRecord._id as ObjectId),
			},
			{
				$set: {
					workspaceName: input.workspaceName,
					companyName: input.companyName,
					description: input.description,
					logo: normalizePersistedAssetReference(input.logo, workspaceRecord.logo ?? ''),
					plan: input.plan,
					planId: input.planId,
					planStart: input.planStart,
					planEnd: input.planEnd,
					cost: input.cost,
					userIds: userObjectIds,
				},
			},
		);

		const auditRecord: AuditLog = {
			entity: 'workspace',
			entityId: (workspaceRecord._id as ObjectId).toString(),
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'Workspace updated successfully',
			workspace: workspace,
		});
	} catch (err) {
		logError('Update workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update workspace');
	}
};
