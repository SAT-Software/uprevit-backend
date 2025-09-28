import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Project } from '../../models/project';
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

        const db = await getDb();

        const project: Project | null = await db.collection<Project>('projects').findOne({
            _id: new ObjectId(event.pathParameters.id),
            isArchived: { $ne: true },
        });

        if (!project) {
            return ResponseWrapper.notFound('Project not found');
        }

        return ResponseWrapper.success({
            message: 'Project retrieved successfully',
            project: project,
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
