import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { getDb } from '../../utils/db';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { ObjectId } from 'mongodb';
import { SourceFile } from '../../models/sourceFiles';
import type { Product } from '../../models/product';
import { buildListFiltersMatch, ListFilterField, parseListQuery } from '../../utils/listQuery';
import { attachSourceFolderFileCounts } from '../../utils/sourceFolderFileCounts';

const ALLOWED_SORT_FIELDS = ['name', '_id'];

const SOURCE_FILES_FILTER_FIELDS: Record<string, ListFilterField> = {
	name: { path: 'name', type: 'text' },
};

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

		const listQueryResult = parseListQuery({
			query: event.queryStringParameters,
			allowedSortFields: ALLOWED_SORT_FIELDS,
			defaultSort: 'name',
		});
		if (listQueryResult.error) return listQueryResult.error;

		const { limit, page, skip, sort, order, filters } = listQueryResult.value!;

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

		const match: Record<string, unknown> = {
			workspace_id: context.workspaceId,
			type: 'folder',
			parentId: { $eq: null },
		};

		if (productId) {
			match.product_id = new ObjectId(productId);
		}

		const filtersMatch = buildListFiltersMatch(filters, SOURCE_FILES_FILTER_FIELDS);
		if (filtersMatch.error) return filtersMatch.error;
		if (filtersMatch.match) {
			Object.assign(match, filtersMatch.match);
		}

		const sortObj: { [key: string]: 1 | -1 } = {};
		sortObj[sort] = order === 'desc' ? -1 : 1;

		const [sourceFileFolders, totalCount] = await Promise.all([
			sourceFilesCollection.find(match).sort(sortObj).skip(skip).limit(limit).toArray(),
			sourceFilesCollection.countDocuments(match),
		]);

		const foldersWithFileCounts = await attachSourceFolderFileCounts(
			sourceFilesCollection,
			sourceFileFolders,
			context.workspaceId,
		);

		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message:
				totalCount === 0
					? 'No source file folders found for the given workspace.'
					: 'Source file folders fetched successfully.',
			result: {
				folders: foldersWithFileCounts,
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
		logError('Get all source files folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get source file folders');
	}
};
