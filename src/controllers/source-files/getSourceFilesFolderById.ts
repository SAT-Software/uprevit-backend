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
        // Extract folderId from path parameters
        const folderId = event.pathParameters?.id;

        // Validate required folderId parameter
        if (!folderId) {
            return ResponseWrapper.badRequest('Missing required path parameter: id');
        }

        // Validate ObjectId format for folderId
        if (!ObjectId.isValid(folderId)) {
            return ResponseWrapper.badRequest('Invalid folder ID format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Find the source files folder by ID
        const folder: SourceFiles | null = await db.collection<SourceFiles>('sourceFiles').findOne({
            _id: new ObjectId(folderId)
        });

        if (!folder) {
            return ResponseWrapper.notFound('Source files folder not found');
        }

        // Transform the data to match the required response format
        const responseData = {
            _id: folder._id,
            folder_name: folder.folder_name,
            product_id: folder.product_id,
            workspace_id: folder.workspace_id
        };

        return ResponseWrapper.success({
            data: responseData
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};