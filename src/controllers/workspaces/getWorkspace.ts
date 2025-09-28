import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { verifyJWT } from '../../utils/authUtils';

/**
 * API endpoint to get a workspace by id
 * @param event - API Gateway Lambda Proxy Input Format
 * @returns 
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!event.pathParameters?.id) {
			return ResponseWrapper.badRequest('Missing required fields: id is required');
		}

		const authHeader = event.headers?.Authorization || event.headers?.authorization;
		
		if(!authHeader) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const token = authHeader.split(' ')[1];
		const { isValid, payload } = await verifyJWT(token);
		
		if(!isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
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