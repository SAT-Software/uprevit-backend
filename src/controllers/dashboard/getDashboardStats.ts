import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';

/**
 * API endpoint to get dashboard statistics for a workspace
 * @param event - API Gateway Lambda Proxy Input Format
 * @returns Dashboard statistics including counts for departments, projects, products, and source files
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const requestedWorkspaceId = event.queryStringParameters?.id;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspace id');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const db = await getDb();
		const workspaceObjectId = context.workspaceId;

		// Count departments for the workspace
		const departmentsPromise = db.collection('departments').countDocuments({
			workspace_id: workspaceObjectId,
			isArchived: false,
		});

		const sourceFilesPromise = db.collection('sourceFiles').countDocuments({
			workspace_id: workspaceObjectId,
			type: 'file',
		});

		const projectAndProductStatsPromise = db.collection('projects').aggregate([
			{
				$match: {
					workspace_id: workspaceObjectId,
					isArchived: false
				}
			},
			{
				$lookup: {
					from: 'products',
					let: { projectId: '$_id' },
					pipeline: [
						{
							$match: {
								$expr: { $eq: ['$project_id', '$$projectId'] },
								status: { $ne: 'archived' }
							}
						}
					],
					as: 'projectProducts'
				}
			},
			{
				$group: {
					_id: null,
					totalProjects: { $sum: 1 },
					totalProducts: { $sum: { $size: '$projectProducts' } }
				}
			},
			{
				$project: {
					_id: 0,
					totalProjects: 1,
					totalProducts: 1
				}
			}
		]).toArray();
			
		const [totalDepartments, totalSourceFiles, projectAndProductStats] = await Promise.all([
			departmentsPromise,
			sourceFilesPromise,
			projectAndProductStatsPromise,
		]);

		const stats = projectAndProductStats[0] || { totalProjects: 0, totalProducts: 0 };

		return ResponseWrapper.success({
			message: 'Dashboard statistics retrieved successfully',
			data: {
				total_departments: totalDepartments,
				total_projects: stats.totalProjects,
				total_products: stats.totalProducts,
				total_source_files: totalSourceFiles,
			},
		});
	} catch (err) {
		logError('Get dashboard stats handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get dashboard stats');
	}
};
