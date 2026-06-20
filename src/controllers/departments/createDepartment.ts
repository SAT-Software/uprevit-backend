import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';

/**
 * Create a department
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');
	

		const missingFieldsResult = validateMissingFields({
			'department_name': input.department_name,
			'department_description': input.department_description,
			'admin_id': input.admin_id.toString(),
		});
		if (missingFieldsResult) return missingFieldsResult;

		if (input.workspace_id) {
			const workspaceMismatch = assertWorkspaceMatch(input.workspace_id, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		
		const objectIdValidation = validateAllObjectIds({
			'admin_id': input.admin_id,
		}, {
			'users': input.users,
		});
		if (objectIdValidation) return objectIdValidation;
		

		const db = await getDb();
		
		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = context.workspaceId;
		const userObjectIds = input.users ? input.users.map((userId: string) => new ObjectId(userId)) : [];
		const normalizedDepartmentImage = normalizePersistedAssetReference(input.image, '');

		const department = await db.collection<Department>('departments').insertOne({
			department_name: input.department_name,
			department_description: input.department_description,
			image: normalizedDepartmentImage,
			manager: input.manager,
			admin_id: adminObjectId,
			workspace_id: workspaceObjectId,
			users: userObjectIds,
			isArchived: false,
		});

		await recordAuditEvent({
			workspaceId: workspaceObjectId.toString(),
			scope: { type: 'department', id: department.insertedId.toString() },
			entity: { type: 'department', id: department.insertedId.toString() },
			action: 'create',
			eventKey: 'department.created',
			visibility: 'admin',
			where: { module: 'departments' },
			auth: auth.payload,
			after: {
				department_name: input.department_name,
				department_description: input.department_description,
				manager: input.manager,
			},
			changedPaths: ['department_name', 'department_description', 'manager'],
			meta: {
				departmentName: input.department_name,
			},
		});

		await recordCommittedUploadIfNew({
			workspaceId: workspaceObjectId,
			previousKey: '',
			newKey: normalizedDepartmentImage,
			sizeBytes: input.imageSizeBytes ?? input.sizeBytes,
			metadata: { assetType: 'department_image' },
		});

		return ResponseWrapper.created({
			message: 'Department created successfully',
			department: department,
		});

	} catch (err) {
		logError('Create department handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create department');
	}
}; 
