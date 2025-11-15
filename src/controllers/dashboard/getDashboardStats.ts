import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * API endpoint to get dashboard statistics for a workspace
 * @param event - API Gateway Lambda Proxy Input Format
 * @returns Dashboard statistics including counts for departments, projects, products, and source files
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
	    // Extract workspaceId from query parameters
	    const workspaceId = event.queryStringParameters?.id;

	    if (!workspaceId) {
	        return ResponseWrapper.badRequest('Missing required fields: id (workspaceId) is required');
	    }

		const validationResult = validateAllObjectIds({
			'_id': workspaceId,
		});
			
		if (validationResult) {
			return validationResult;
		}

		const auth = await authenticateRequest(event);

		if (!auth.isValid) {
			return auth.error;
		}

		const db = await getDb();
		const workspaceObjectId = new ObjectId(workspaceId);

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
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
