import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Project } from '../../models/project';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Get all projects
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		
		if(!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();

		// Extract query parameters for pagination
		const limit = parseInt(event.queryStringParameters?.limit || '10');
		const page = parseInt(event.queryStringParameters?.page || '1');
		const sort = event.queryStringParameters?.sort || 'actionAt';
		const workspaceId = event.queryStringParameters?.workspaceId;
		const isArchiveParam = event.queryStringParameters?.isArchive || 'false';

		if (!workspaceId) return ResponseWrapper.badRequest('Workspace ID is required.');


		// Validate isArchive parameter
		if (isArchiveParam !== 'true' && isArchiveParam !== 'false') {
			return ResponseWrapper.badRequest('isArchive parameter must be true or false');
		}

		// Convert to boolean
		const isArchive = isArchiveParam === 'true';

		// Validate pagination parameters
		if (limit < 1 || limit > 100) {
			return ResponseWrapper.badRequest('Limit must be between 1 and 100');
		}

		if (page < 1) {
			return ResponseWrapper.badRequest('Page must be greater than 0');
		}

		// Validate sort field
		const allowedSortFields = [
			'project_name',
			'project_number',
			'project_description',
			'project_manager',
			'_id',
			'actionAt',
		];
		if (!allowedSortFields.includes(sort)) {
			return ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`);
		}

		const skip = (page - 1) * limit;

		// filter based on isArchive parameter
		const filter = isArchive
			? { isArchived: true, workspace_id: new ObjectId(workspaceId) }
			: { isArchived: { $ne: true }, workspace_id: new ObjectId(workspaceId) };

		// If sorting by actionAt, use aggregation to join with audit_logs
		if (sort === 'actionAt') {
			// aggregation pipeline
			const pipeline = [
				{ $match: filter },
				{
					$lookup: {
						from: 'audit_logs',
						let: { projectId: { $toString: '$_id' } },
						pipeline: [
							{
								$match: {
									$expr: {
										$and: [
											{ $eq: ['$entityId', '$$projectId'] },
											{ $eq: ['$entity', 'project'] },
											{ $eq: ['$active', true] },
										],
									},
								},
							},
							{ $sort: { actionAt: -1 } },
							{ $limit: 1 },
						],
						as: 'latestAuditLog',
					},
				},
				{
					$addFields: {
						actionAt: {
							$ifNull: [
								{ $arrayElemAt: ['$latestAuditLog.actionAt', 0] },
								new Date(0), // Default to epoch if no audit log found
							],
						},
					},
				},
				{ $sort: { actionAt: -1 } },
				{ $skip: skip },
				{ $limit: limit },
				{
					$project: {
						latestAuditLog: 0, // Remove the audit log data from final result
					},
				},
			];

			// Get total count for pagination
			const countPipeline = [{ $match: filter }, { $count: 'total' }];

			const [projects, countResult] = await Promise.all([
				db.collection<Project>('projects').aggregate(pipeline).toArray(),
				db.collection<Project>('projects').aggregate(countPipeline).toArray(),
			]);

			const totalCount = countResult.length > 0 ? countResult[0].total : 0;
			const totalPages = Math.ceil(totalCount / limit);

			return ResponseWrapper.success({message: 'Projects fetched successfully',
				result: {
					projects,
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
		} else {
			// For other sort fields, use regular find with sort
			const sortObj: { [key: string]: 1 | -1 } = {};
			sortObj[sort] = 1;

			// Get total count based on archived filter
			const totalCount = await db.collection<Project>('projects').countDocuments(filter);

			// Get paginated projects based on archived filter
			const projects = await db
				.collection<Project>('projects')
				.find(filter)
				.sort(sortObj)
				.skip(skip)
				.limit(limit)
				.toArray();

			const totalPages = Math.ceil(totalCount / limit);


			return ResponseWrapper.success({message: 'Projects fetched successfully',
				result: {
					projects,
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
		}
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
