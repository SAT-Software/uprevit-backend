import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
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

		const  validateWorkspaceId = validateAllObjectIds({ workspaceId });
		if (validateWorkspaceId) return validateWorkspaceId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const sourceFileFolders = await sourceFilesCollection.find({
			workspace_id: new ObjectId(workspaceId),
			type: 'folder',
			parentId: { $eq: null }
		}).toArray();

		if(!sourceFileFolders || sourceFileFolders.length === 0) {
			return ResponseWrapper.success({
				message: 'No source file folders found for the given workspace.',
				result: []
			});
		}

		return ResponseWrapper.success({
			message: 'Source file folders fetched successfully.',
			result: sourceFileFolders
		})
        
	} catch (error) {
		console.error('Get all source files folders handler failed');
		return ResponseWrapper.internalServerError('Failed to get source file folders');
	}
}