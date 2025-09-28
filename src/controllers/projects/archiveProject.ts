import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

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

				const auth = await authenticateRequest(event);
				if(!auth.isValid) {
					return auth.error;
				}

	    if (!event.pathParameters?.id) {
	        return ResponseWrapper.badRequest('Missing required fields: id is required');
	    }

	    if (!ObjectId.isValid(event.pathParameters.id)) {
	        return ResponseWrapper.badRequest('Invalid id format. Must be a valid MongoDB ObjectId.');
	    }

	    const db = await getDb();

	    // Check if project exists and is not already archived
	    const projectRecord: Project | null = await db.collection<Project>('projects').findOne({
	        _id: new ObjectId(event.pathParameters.id),
	        isArchived: { $ne: true },
	    });

	    if (!projectRecord) {
						return ResponseWrapper.notFound('Project not found or already archived');
	    }

	    // Archive the project instead of deleting it
	    const project = await db.collection<Project>('projects').updateOne(
	        {
	            _id: new ObjectId(event.pathParameters.id),
	        },
	        {
	            $set: {
	                isArchived: true,
	            },
	        },
	    );

	    await updateAuditLog({
					entity: 'project',
					entityId: event.pathParameters.id,
					action: AuditLogAction.ARCHIVE,
					actionBy: auth.payload?.name?.toString()!,
					actionAt: new Date(),
					active: true,
				});

				return ResponseWrapper.success({
					message: 'Project archived successfully',
					project: project,
				});
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
				return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
