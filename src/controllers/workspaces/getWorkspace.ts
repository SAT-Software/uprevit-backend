import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * API endpoint to get a workspace by id
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();
		
		const workspace: Workspace | null = await db.collection<Workspace>('workspaces').findOne({ _id: new ObjectId(event.pathParameters.id) });

		if (!workspace) {
			return ResponseWrapper.notFound('Workspace not found');
		}

		return ResponseWrapper.success({
			message: 'Workspace retrieved successfully',
			workspace: workspace,
		});
		
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
}; 