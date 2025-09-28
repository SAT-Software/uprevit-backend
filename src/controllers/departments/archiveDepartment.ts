import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import { type AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';
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

		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const validationResult = validateAllObjectIds({
			'_id': event.pathParameters.id,
		});
				
		if (validationResult) {
			return validationResult;
		}

		const db = await getDb();

		// Check if department exists and is not already archived
		const departmentRecord: Department | null = await db.collection<Department>('departments').findOne({
			_id: new ObjectId(event.pathParameters.id),
			isArchived: { $ne: true },
		});

		if (!departmentRecord) {
			return ResponseWrapper.notFound('Department not found or already archived');
		}

		// Archive the department instead of deleting it
		const department = await db.collection<Department>('departments').updateOne(
			{
				_id: new ObjectId(event.pathParameters.id),
			},
			{
				$set: {
					isArchived: true,
				},
			},
		);

		const auditRecord: AuditLog = {
			entity: 'department',
			entityId: (event.pathParameters?.id).toString(),
			action: AuditLogAction.ARCHIVE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		};

		await updateAuditLog(auditRecord);

		return ResponseWrapper.success({
			message: 'Department archived successfully',
			department: department,
		});
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
