import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
	EXPORT_JOB_COLLECTION,
	EXPORT_JOB_FORMATS,
	type ExportJobFormat,
} from '../../models/exportJob';
import type { Product } from '../../models/product';
import { authenticateRequest } from '../../utils/authUtils';
import { getDb } from '../../utils/db';
import { enqueueExportJobMessage } from '../../utils/exportQueue';
import { logError } from '../../utils/logger';
import {
	createQueuedProductExportJob,
} from '../../utils/productExportJobs';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { getAuthenticatedUserContext } from '../../utils/authenticatedUser';
import { assertUsageActionAllowed } from '../../utils/billing/enforcement';

/**
 * Queues a product export job from request body format.
 * @param {APIGatewayProxyEvent} event - API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Accepted response with job id
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	if (!event.body) {
		return ResponseWrapper.badRequest('Request body is required');
	}

	let format: ExportJobFormat | undefined;

	try {
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(event.body);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return ResponseWrapper.badRequest('Request body contains invalid JSON');
			}

			throw error;
		}

		if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
			return ResponseWrapper.badRequest('Request body must be a JSON object');
		}

		const body = parsedBody as { format?: unknown };
		if (typeof body.format !== 'string' || !EXPORT_JOB_FORMATS.includes(body.format as ExportJobFormat)) {
			return ResponseWrapper.badRequest(`Request body must include 'format' and must be one of: ${EXPORT_JOB_FORMATS.join(', ')}`);
		}

		format = body.format as ExportJobFormat;

		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const productId = event.pathParameters?.productId;
		if (!productId) return ResponseWrapper.badRequest("Product id - 'productId' is required in path parameters");

		const validationError = validateAllObjectIds({ productId });
		if (validationError) return validationError;

		const cognitoSub = auth.payload.sub;
		if (!cognitoSub) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const userContext = await getAuthenticatedUserContext(cognitoSub);
		if (!userContext) {
			return ResponseWrapper.unauthorized('Unable to resolve authenticated user context');
		}

		const db = await getDb();
		const productObjectId = new ObjectId(productId);
		const product = await db.collection<Product>('products').findOne(
			{ _id: productObjectId },
			{ projection: { _id: 1, workspace_id: 1 } },
		);

		if (!product?._id) {
			return ResponseWrapper.notFound('Product not found');
		}

		if (product.workspace_id.toString() !== userContext.workspaceId.toString()) {
			return ResponseWrapper.forbidden('You are not authorized to export this product');
		}

		const exportCheck = await assertUsageActionAllowed(userContext.workspaceId, 'export', 1);
		if (!exportCheck.allowed) return ResponseWrapper.forbidden(exportCheck.reason);

		const job = await createQueuedProductExportJob({
			productId: productObjectId,
			workspaceId: product.workspace_id,
			requestedBySub: cognitoSub,
			requestedByUserId: userContext.userId,
			format,
		});

		try {
			await enqueueExportJobMessage({
				schemaVersion: 1,
				jobId: job._id.toString(),
				target: 'product',
				targetId: productObjectId.toString(),
				workspaceId: product.workspace_id.toString(),
				requestedBySub: cognitoSub,
				requestedByUserId: userContext.userId.toString(),
				format,
				queuedAt: job.createdAt.toISOString(),
			});
		} catch (queueError) {
			await db.collection(EXPORT_JOB_COLLECTION).deleteOne({ _id: job._id });
			throw queueError;
		}

		return ResponseWrapper.accepted({
			message: 'Product export queued successfully',
			result: {
				jobId: job._id.toString(),
				status: job.status,
			},
		});
	} catch (error) {
		logError('Failed to queue product export', error, { format });
		return ResponseWrapper.internalServerError('Failed to queue product export');
	}
};
