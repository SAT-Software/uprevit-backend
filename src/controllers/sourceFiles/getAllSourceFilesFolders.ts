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

		const productId = event.queryStringParameters?.productId;

		const  validateWorkspaceId = validateAllObjectIds({
			workspaceId,
			...(productId && { productId })
		});
		if (validateWorkspaceId) return validateWorkspaceId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const query: any = {
			workspace_id: new ObjectId(workspaceId),
			type: 'folder',
			parentId: { $eq: null }
		};

		if (productId) {
			query.product_id = new ObjectId(productId);
		}

		const sourceFileFolders = await sourceFilesCollection.find(query).toArray();

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
		console.error('Error in getAllSourceFilesFolders:', error);
		return ResponseWrapper.internalServerError(error instanceof Error ? error.message : 'Something went wrong while fetching source file folders.');
	}
}