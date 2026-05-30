import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext, tenantObjectIdFilter } from "../../utils/tenantContext";
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
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const requestedWorkspaceId = event.queryStringParameters?.workspaceId;
		const id = event.queryStringParameters?.id;

		if (!id) return ResponseWrapper.badRequest('Missing required query parameter: id');

		const validationError = validateAllObjectIds({ id });
		if (validationError) return validationError;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspaceId');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const sourceFileOrFolder = await sourceFilesCollection.findOne(
			tenantObjectIdFilter(id, context.workspaceId),
		);

		if (!sourceFileOrFolder) {
			return ResponseWrapper.notFound('Folder or file not found.');
		}

		if (sourceFileOrFolder.type === 'file' && sourceFileOrFolder.key) {
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
