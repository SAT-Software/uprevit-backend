import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateRole } from '../../utils/authUtils';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const authHeader = event.headers?.Authorization || event.headers?.authorization;
		if(!authHeader) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const token = authHeader.split(' ')[1];

		const { isValid, payload } = await validateRole(token, 'admin');
		if(!isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		let input: Department;
		
		try {
			input = JSON.parse(event.body!);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const missingFieldsResult = validateMissingFields({
			'department_name': input.department_name,
			'department_description': input.department_description,
			'admin_id': input.admin_id.toString(),
			'workspace_id': input.workspace_id.toString(),
		});

		if (missingFieldsResult) {
			return missingFieldsResult;
		}
		
		const objectIdValidation = validateAllObjectIds({
			'admin_id': input.admin_id,
			'workspace_id': input.workspace_id,
		}, {
			'users': input.users,
		});

		if (objectIdValidation) {
			return objectIdValidation;
		}
		

		const db = await getDb();
		
		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.users ? input.users.map(userId => new ObjectId(userId)) : [];

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

		await updateAuditLog({
			entity: 'department',
			entityId: department.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Department created successfully',
			department: department,
		});

	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}; 