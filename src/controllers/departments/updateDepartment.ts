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
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';

/**
 * Update a department
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

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: Department = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			'department_name': input.department_name,
			'department_description': input.department_description,
			'admin_id': input.admin_id.toString(),
			'_id': input._id!.toString(),
		});

		if(missingFieldsResult) {
			return missingFieldsResult;
		}

		if (input.workspace_id) {
			const workspaceMismatch = assertWorkspaceMatch(input.workspace_id, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const objectIdValidation = validateAllObjectIds({
			'_id': input._id!,
			'admin_id': input.admin_id,
		}, {
			'users': input.users,
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();
		const departmentFilter = tenantObjectIdFilter(input._id!, context.workspaceId);

		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne(departmentFilter);

		if (!departmentRecord) {
			return ResponseWrapper.badRequest('Department not found');
		}

		const adminObjectId = new ObjectId(input.admin_id);
		const userObjectIds = input.users ? input.users.map((userId) => new ObjectId(userId)) : [];
		const normalizedDepartmentImage = normalizePersistedAssetReference(input.image, departmentRecord.image ?? '');

		const department = await db.collection<Department>('departments').updateOne(
			departmentFilter,
			{
				$set: {
					department_name: input.department_name,
					department_description: input.department_description,
					image: normalizedDepartmentImage,
					manager: input.manager,
					admin_id: adminObjectId,
					users: userObjectIds,
				},
			},
		);

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'department', id: (departmentRecord._id as ObjectId).toString() },
			entity: { type: 'department', id: (departmentRecord._id as ObjectId).toString() },
			action: 'update',
			eventKey: 'department.updated',
			visibility: 'admin',
			where: { module: 'departments' },
			auth: auth.payload,
			before: {
				department_name: departmentRecord.department_name,
				department_description: departmentRecord.department_description,
				manager: departmentRecord.manager,
				users: departmentRecord.users?.map((user) => user.toString()) ?? [],
			},
			after: {
				department_name: input.department_name,
				department_description: input.department_description,
				manager: input.manager,
				users: input.users ?? [],
			},
			changedPaths: ['department_name', 'department_description', 'manager', 'users'],
			meta: {
				departmentName: input.department_name,
			},
		});

		await recordCommittedUploadIfNew({
			workspaceId: context.workspaceId,
			previousKey: departmentRecord.image,
			newKey: normalizedDepartmentImage,
			sizeBytes: (input as Department & { imageSizeBytes?: number; sizeBytes?: number }).imageSizeBytes
				?? (input as { sizeBytes?: number }).sizeBytes,
			metadata: { assetType: 'department_image' },
		});

		return ResponseWrapper.success({
			message: 'Department updated successfully',
			department: department,
		});
	} catch (err) {
		logError('Update department handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update department');
	}
};
