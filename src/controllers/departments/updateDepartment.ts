import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { type AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { authenticateWithRole } from '../../utils/authUtils';

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

		const auth = await authenticateWithRole(event, 'admin');
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: Department = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			'department_name': input.department_name,
			'department_description': input.department_description,
			'admin_id': input.admin_id.toString(),
			'workspace_id': input.workspace_id.toString(),
			'_id': input._id!.toString(),
		});

		if(missingFieldsResult) {
			return missingFieldsResult;
		}

		const objectIdValidation = validateAllObjectIds({
			'_id': input._id!,
			'admin_id': input.admin_id,
			'workspace_id': input.workspace_id,
		}, {
			'users': input.users,
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();

		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne({
			_id: new ObjectId(input._id),
		});

		if (!departmentRecord) {
			return ResponseWrapper.badRequest('Department not found');
		}

		const adminObjectId = new ObjectId(input.admin_id);
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const userObjectIds = input.users ? input.users.map((userId) => new ObjectId(userId)) : [];

		const department = await db.collection<Department>('departments').updateOne(
			{
				_id: new ObjectId(departmentRecord._id as ObjectId),
			},
			{
				$set: {
					department_name: input.department_name,
					department_description: input.department_description,
					image: input.image,
					manager: input.manager,
					admin_id: adminObjectId,
					workspace_id: workspaceObjectId,
					users: userObjectIds,
				},
			},
		);

		const auditRecord: AuditLog = {
			entity: 'department',
			entityId: (departmentRecord._id as ObjectId).toString(),
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'Department updated successfully',
			department: department,
		});
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
