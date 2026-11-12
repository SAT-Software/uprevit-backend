import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Document, ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { UserBookmarks } from '../../models/bookmarks';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';
import { buildProductStatusMatch } from '../../utils/productLifecycle';
import { parseListQuery } from '../../utils/listQuery';
import { signProductTeamAvatars } from '../../utils/productAccess';
import { withTelemetry } from '../../utils/telemetry';
import { buildProductListPipeline, buildProductSearchOr, PRODUCT_LIST_SORT_FIELDS } from '../../utils/productListPipeline';

/**
 * Returns a success response with an empty products array when no bookmarked products are found.
 * @param {number} page - The current page number.
 * @param {number} limit - The number of items per page.
 * @return {APIGatewayProxyResult} A success response with an empty products array.
 */
function emptyProductsResult(page: number, limit: number): APIGatewayProxyResult {
	return ResponseWrapper.success({
		message: 'No bookmarked products found',
		result: {
			products: [],
			pagination: {
				currentPage: page,
				totalPages: 0,
				totalCount: 0,
				limit,
				hasNextPage: false,
				hasPrevPage: false,
			},
		},
	});
}


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

		const bookmarks = await db.collection<UserBookmarks>('bookmarks').findOne({
			user_id: context.userId,
			workspace_id: context.workspaceId,
		});

		const bookmarkedProductIds = new Set<ObjectId>();
		for (const folder of bookmarks?.product_folders ?? []) {
			for (const productId of folder.products ?? []) {
				bookmarkedProductIds.add(productId);
			}
		}

		if (bookmarkedProductIds.size === 0) {
			return emptyProductsResult(page, limit);
		}

		const filter: Record<string, unknown> = {
			workspace_id: context.workspaceId,
			_id: { $in: Array.from(bookmarkedProductIds) },
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

		// Bookmarks deliberately default to all versions, not only the latest (dff6191).
		const isLatest = event.queryStringParameters?.isLatest === 'true';
		if (isLatest) filter.is_latest = true;

		const built = buildProductListPipeline({ match: filter, isArchiveOnlyStatus, filters, sort, order, skip, limit });
		if (built.error) return built.error;

		const [pageResult] = await db.collection<Product>('products')
			.aggregate<{ rows: Document[]; total: { total: number }[] }>(built.pipeline!)
			.toArray();
		const products = pageResult?.rows ?? [];
		const totalCount = pageResult?.total?.[0]?.total ?? 0;

		const productsWithTeam = await signProductTeamAvatars(products, {
			workspaceId: context.workspaceId,
			pendingOwnerId: context.cognitoSub,
		});
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Bookmarked products fetched successfully',
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
	} catch (error) {
		logError('Get all bookmarked products handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get bookmarked products');
	}
});
