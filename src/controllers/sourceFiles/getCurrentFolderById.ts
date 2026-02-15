import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { createPresignedGetUrl } from "../../utils/s3-storage";

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

		const workspaceId = event.queryStringParameters?.workspaceId;
		if (!workspaceId) return ResponseWrapper.badRequest('Missing required query parameter: workspaceId');

		const id = event.queryStringParameters?.id;
		if (!id) return ResponseWrapper.badRequest('Missing required query parameter: id');

		const validationError = validateAllObjectIds({ workspaceId, id });
		if (validationError) return validationError;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const query = {
			workspace_id: new ObjectId(workspaceId),
			_id: new ObjectId(id),
		};

		const sourceFileOrFolder = await sourceFilesCollection.findOne(query);

		if (sourceFileOrFolder?.type === 'file' && sourceFileOrFolder.key) {
			try {
				sourceFileOrFolder.url = await createPresignedGetUrl(sourceFileOrFolder.key);
			} catch (error) {
				logError('Failed to generate signed URL for source file', error);
			}
		}


		return ResponseWrapper.success({
			message: 'Parent folder fetched successfully.',
			result: sourceFileOrFolder
		})
        
	} catch (error) {
		logError('Get current folder by ID handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get folder');
	}
}
