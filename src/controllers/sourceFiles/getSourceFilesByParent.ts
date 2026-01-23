import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

		const workspaceId = event.queryStringParameters?.workspaceId;
		if (!workspaceId) return ResponseWrapper.badRequest('Missing required query parameter: workspace_id');

		const parentId = event.queryStringParameters?.parentId;
		if (!parentId) return ResponseWrapper.badRequest('Missing required query parameter: parentId');

		const validationError = validateAllObjectIds({ workspaceId, parentId });
		if (validationError) return validationError;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const query: any = {
			workspace_id: new ObjectId(workspaceId),
			parentId: new ObjectId(parentId),
		};

		const sourceFilesAndFolders = await sourceFilesCollection.find(query).toArray();

		if(!sourceFilesAndFolders || sourceFilesAndFolders.length === 0) {
			return ResponseWrapper.success({
				message: 'No source files or folders found for the given criteria.',
				result: []
			});
		}

		return ResponseWrapper.success({
			message: 'Source files and folders fetched successfully.',
			result: sourceFilesAndFolders
		})
        
	} catch (error) {
		logError('Get source files by parent handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get source files');
	}
}