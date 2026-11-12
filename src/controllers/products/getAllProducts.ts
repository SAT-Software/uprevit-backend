import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Document, ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { addProductReleaseInfo, buildProductStatusMatch } from '../../utils/productLifecycle';
import { parseListQuery } from '../../utils/listQuery';
import { signProductTeamAvatars } from '../../utils/productAccess';
import { withTelemetry } from '../../utils/telemetry';
import { buildProductListPipeline, buildProductSearchOr, PRODUCT_LIST_SORT_FIELDS } from '../../utils/productListPipeline';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const db = await getDb();

		const listQueryResult = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: PRODUCT_LIST_SORT_FIELDS,
			defaultSort: 'product_name',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;
		const statusFilter = event.queryStringParameters?.status;
		const filterParam = event.queryStringParameters?.filter;
		const requestedWorkspaceId = event.queryStringParameters?.workspaceId;
		const projectId = event.queryStringParameters?.projectId;
		const departmentId = event.queryStringParameters?.departmentId;
		const ownerId = event.queryStringParameters?.ownerId;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspaceId');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		// Build filter object
		const filter: Record<string, unknown> = {
			workspace_id: context.workspaceId,
		};

		if (projectId) {
			if (!ObjectId.isValid(projectId)) return ResponseWrapper.badRequest('Invalid projectId');
			filter.project_id = new ObjectId(projectId);
		}

		if (departmentId) {
			if (!ObjectId.isValid(departmentId)) return ResponseWrapper.badRequest('Invalid departmentId');
			filter.department_id = new ObjectId(departmentId);
		}

		if (ownerId) {
			if (!ObjectId.isValid(ownerId)) return ResponseWrapper.badRequest('Invalid ownerId');
			filter.owner_user_id = new ObjectId(ownerId);
		}

		const { isArchive: isArchiveOnlyStatus, match: statusMatch } = buildProductStatusMatch(statusFilter);
		Object.assign(filter, statusMatch);

		const search = buildProductSearchOr(filterParam);
		if (search.error) return search.error;
		if (search.or) filter.$or = search.or;

		const isLatest = event.queryStringParameters?.isLatest !== 'false';
		if (isLatest) filter.is_latest = true;

		const built = buildProductListPipeline({ match: filter, isArchiveOnlyStatus, filters, sort, order, skip, limit });
		if (built.error) return built.error;

		const [pageResult] = await db.collection<Product>('products')
			.aggregate<{ rows: Document[]; total: { total: number }[] }>(built.pipeline!)
			.toArray();
		const products = pageResult?.rows ?? [];
		const totalCount = pageResult?.total?.[0]?.total ?? 0;

		const productsWithTeam = await addProductReleaseInfo(db, context.workspaceId, await signProductTeamAvatars(products, {
			workspaceId: context.workspaceId,
			pendingOwnerId: context.cognitoSub,
		}));
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Products fetched successfully',
			result: {
				products: productsWithTeam,
				pagination: {
					currentPage: page,
					totalPages,
					totalCount,
					limit,
					hasNextPage: page < totalPages,
					hasPrevPage: page > 1,
				},
			},
		});
	} catch (err) {
		logError('Get all products handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get products');
	}
});
