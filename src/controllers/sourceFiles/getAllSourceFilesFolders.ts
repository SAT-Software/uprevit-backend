import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext, tenantObjectIdFilter } from "../../utils/tenantContext";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import type { Product } from "../../models/product";

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
		const productId = event.queryStringParameters?.productId;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspaceId');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		if (productId) {
			const validateProductId = validateAllObjectIds({ productId });
			if (validateProductId) return validateProductId;
		}

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		if (productId) {
			const product = await db.collection<Product>('products').findOne(
				tenantObjectIdFilter(productId, context.workspaceId),
			);
			if (!product) return ResponseWrapper.notFound('Product not found.');
		}

		const query: Record<string, unknown> = {
			workspace_id: context.workspaceId,
			type: 'folder',
			parentId: { $eq: null },
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
		logError('Get all source files folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get source file folders');
	}
}
