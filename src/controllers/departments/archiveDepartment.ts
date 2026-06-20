import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateBoolean } from '../../utils/validationUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { isWorkspaceAdmin, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';

/**
 * Archive a department
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

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const validationResult = validateAllObjectIds({
			'_id': event.pathParameters.id,
		});
				
		if (validationResult) {
			return validationResult;
		}

		const departmentId = event.pathParameters.id.toString();

		const db = await getDb();

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');

		const isArchived = input.isArchived;

		const isBoolean = validateBoolean(isArchived, 'isArchived');
		if (isBoolean) return isBoolean;

		const departmentFilter = tenantObjectIdFilter(departmentId, context.workspaceId);

		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne(departmentFilter);

		if (!departmentRecord) {
			return ResponseWrapper.notFound('Department not found');
		}

		const department = await db.collection<Department>('departments').updateOne(
			departmentFilter,
			{
				$set: {
					isArchived: isArchived,
				},
			},
		);

		const action = isArchived ? 'archive' : 'restore';
		const eventKey = isArchived ? 'department.archived' : 'department.restored';

		try {
			await recordAuditEvent({
				workspaceId: context.workspaceId.toString(),
				scope: { type: 'department', id: departmentId },
				entity: { type: 'department', id: departmentId },
				action,
				eventKey,
				visibility: 'admin',
				where: { module: 'departments' },
				auth: auth.payload,
				before: { isArchived: departmentRecord.isArchived },
				after: { isArchived },
				changedPaths: ['isArchived'],
				meta: {
					departmentName: departmentRecord.department_name,
				},
			});
		} catch (auditError) {
			logError('Department archive audit event failed', auditError, {
				departmentName: departmentRecord.department_name,
				workspaceId: context.workspaceId.toString(),
				action,
				departmentId,
			});
		}

		return ResponseWrapper.success({
			message: `Department ${isArchived ? 'archived' : 'restored'} successfully`,
			department: department,
		});
	} catch (err) {
		logError('Archive department handler failed', err);
		return ResponseWrapper.internalServerError('Failed to archive department');
	}
};
