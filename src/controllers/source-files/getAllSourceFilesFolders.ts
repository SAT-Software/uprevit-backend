import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SourceFiles } from '../../models/sourceFiles';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';

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
        // Extract workspaceId from query parameters
        const workspaceId = event.queryStringParameters?.workspaceId;

        // Validate required workspaceId parameter
        if (!workspaceId) {
            return ResponseWrapper.badRequest('Missing required query parameter: workspaceId');
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(workspaceId)) {
            return ResponseWrapper.badRequest('Invalid workspaceId format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Build filter for workspace_id
        const filter = {
            workspace_id: new ObjectId(workspaceId)
        };

        // MongoDB projection to select only required fields
        const projection = {
            _id: 1,
            folder_name: 1,
            product_id: 1
        };

        // Get all source files folders for the specified workspace
        const sourceFilesFolders = await db
            .collection<SourceFiles>('sourceFiles')
            .find(filter, { projection })
            .sort({ folder_name: 1 }) // Sort by folder name alphabetically
            .toArray();

        // Return response in the specified format
        return ResponseWrapper.success({
            data: sourceFilesFolders
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};