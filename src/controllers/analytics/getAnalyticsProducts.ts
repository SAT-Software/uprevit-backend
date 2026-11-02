import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ANALYTICS_METRICS, AnalyticsMetric, buildDrillDownMatch, parseAnalyticsFilters } from '../../utils/analytics';
import { getDb } from '../../utils/db';
import { parseListQuery } from '../../utils/listQuery';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * API endpoint to list the products behind an analytics chart segment.
 *
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} A page of product summaries matching the requested metric and value
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const query = event.queryStringParameters;
		const parsed = parseAnalyticsFilters(tenantResult.context.workspaceId, query);
		if ('error' in parsed) return ResponseWrapper.badRequest(parsed.error);

		const metric = query?.metric as AnalyticsMetric;
		if (!ANALYTICS_METRICS.includes(metric)) return ResponseWrapper.badRequest('Invalid metric');

		const listQuery = parseListQuery({ query, allowedSortFields: ['product_name'], defaultSort: 'product_name' });
		if (listQuery.error) return listQuery.error;
		const { page, limit, skip, order } = listQuery.value!;

		const db = await getDb();
		const match = await buildDrillDownMatch(db, parsed.filters, metric, query?.value);
		if (!match) return ResponseWrapper.badRequest('Invalid value');

		const productMatch = { ...match, workspace_id: parsed.filters.workspaceId };
		const collection = db.collection('products');
		const [products, totalCount] = await Promise.all([
			collection.aggregate([
				{ $match: productMatch },
				{ $sort: { product_name: order === 'desc' ? -1 : 1, _id: 1 } },
				{ $skip: skip },
				{ $limit: limit },
				{ $lookup: { from: 'departments', localField: 'department_id', foreignField: '_id', as: 'department' } },
				{ $lookup: { from: 'projects', localField: 'project_id', foreignField: '_id', as: 'project' } },
				{
					$project: {
						product_name: 1,
						product_plan_number: 1,
						status: 1,
						version: 1,
						is_latest: 1,
						target_date: 1,
						released_at: 1,
						complete_count: 1,
						department_id: 1,
						project_id: 1,
						department_name: { $arrayElemAt: ['$department.department_name', 0] },
						project_name: { $arrayElemAt: ['$project.project_name', 0] },
					},
				},
			]).toArray(),
			collection.countDocuments(productMatch),
		]);
		const totalPages = Math.ceil(totalCount / limit);

		return ResponseWrapper.success({
			message: 'Analytics products retrieved successfully',
			data: products,
			pagination: {
				currentPage: page,
				totalPages,
				totalCount,
				limit,
				hasNextPage: page < totalPages,
				hasPrevPage: page > 1,
			},
		});
	} catch (err) {
		logError('Get analytics products handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get analytics products');
	}
});
