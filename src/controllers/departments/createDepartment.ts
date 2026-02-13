import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateWithRole } from '../../utils/authUtils';
import { recordAuditEvent } from '../../utils/auditLogV2';

/**
 * Create a department
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateWithRole(event, 'admin');
		if(!auth.isValid) return auth.error;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		const input = JSON.parse(event.body!);
		if(!input) return ResponseWrapper.badRequest('Invalid JSON in request body');
	

		const missingFieldsResult = validateMissingFields({
			'department_name': input.department_name,
			'department_description': input.department_description,
			'admin_id': input.admin_id.toString(),
			'workspace_id': input.workspace_id.toString(),
		});
		if (missingFieldsResult) return missingFieldsResult;

		
		const objectIdValidation = validateAllObjectIds({
			'admin_id': input.admin_id,
			'workspace_id': input.workspace_id,
		}, {
			'users': input.users,
		});
		if (objectIdValidation) return objectIdValidation;
		

		const db = await getDb();
		
		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.users ? input.users.map((userId: string) => new ObjectId(userId)) : [];

		const department = await db.collection<Department>('departments').insertOne({
			department_name: input.department_name,
			department_description: input.department_description,
			image: input.image,
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

		return ResponseWrapper.created({
			message: 'Department created successfully',
			department: department,
		});

	} catch (err) {
		logError('Create department handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create department');
	}
}; 
