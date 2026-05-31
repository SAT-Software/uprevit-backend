import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext } from "../../utils/tenantContext";
import { getDb } from "../../utils/db";

/**
 * @param {APIGatewayProxyEvent} event 
 * @returns {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const db = await getDb();

		const productBookmarkFolders = await db.collection('bookmarks').findOne({
			user_id: context.userId,
			workspace_id: context.workspaceId,
		});

		if(!productBookmarkFolders) return ResponseWrapper.notFound('No product bookmark folders found for the given user.');

		return ResponseWrapper.success({
			message: 'Product bookmark folders fetched successfully.',
			result: {
				 _id: productBookmarkFolders._id,
				user_id: productBookmarkFolders.user_id,
				workspace_id: productBookmarkFolders.workspace_id,
				bookmarked_product_folders: productBookmarkFolders.product_folders || [],
			}
		})
        
	} catch (error) {
		logError('Get all product bookmark folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get product bookmark folders');
	}
}
