import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext, tenantObjectIdFilter } from "../../utils/tenantContext";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { enrichItemsWithSignedUrls } from "../../utils/s3-storage";

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
		const parentId = event.queryStringParameters?.parentId;

		if (!parentId) return ResponseWrapper.badRequest('Missing required query parameter: parentId');

		const validationError = validateAllObjectIds({ parentId });
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

		const parentFolder = await sourceFilesCollection.findOne(
			tenantObjectIdFilter(parentId, context.workspaceId),
		);
		if (!parentFolder) return ResponseWrapper.notFound('Parent folder not found.');

		const query = {
			workspace_id: context.workspaceId,
			parentId: new ObjectId(parentId),
		};

		const sourceFilesAndFolders = await sourceFilesCollection.find(query).toArray();

		if(!sourceFilesAndFolders || sourceFilesAndFolders.length === 0) {
			return ResponseWrapper.success({
				message: 'No source files or folders found for the given criteria.',
				result: []
			});
		}

		const sourceFilesAndFoldersWithSignedUrls = await enrichItemsWithSignedUrls({
			items: sourceFilesAndFolders,
			getKey: (item) => (item.type === 'file' ? item.key : undefined),
			setSignedUrl: (item, signedUrl) => ({
				...item,
				url: signedUrl,
			}),
		});

		return ResponseWrapper.success({
			message: 'Source files and folders fetched successfully.',
			result: sourceFilesAndFoldersWithSignedUrls
		})
        
	} catch (error) {
		logError('Get source files by parent handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get source files');
	}
}
