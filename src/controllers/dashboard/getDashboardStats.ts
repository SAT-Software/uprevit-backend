import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
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

        // Validate ObjectId format
        if (!ObjectId.isValid(workspaceId)) {
            return ResponseWrapper.badRequest('Invalid workspace id format. Must be a valid MongoDB ObjectId.');
        }

				const auth = await authenticateRequest(event);

				if (!auth.isValid) {
					return auth.error;
				}

        const db = await getDb();
        const workspaceObjectId = new ObjectId(workspaceId);

        // Count departments for the workspace
        const departments = db.collection('departments').countDocuments({
            workspace_id: workspaceObjectId,
            isArchived: false,
        });

        // Get projects for the workspace - get both count and IDs
        const projectsQuery = db
            .collection('projects')
            .find({ 
                workspace_id: workspaceObjectId,
                isArchived: false 
            }, { projection: { _id: 1 } })
            .toArray();
				
				const [totalDepartments, projectsData] = await Promise.all([departments, projectsQuery]);

				const totalProjects = projectsData.length;
        const projectObjectIds = projectsData.map((project) => project._id);

        const totalProducts = await db.collection('products').countDocuments({
            project_id: { $in: projectObjectIds },
            status: { $ne: 'archived' },
        });

				
        // TODO: Later on when we implement source files we will need to add the count for source files here

        return ResponseWrapper.success({
            message: 'Dashboard statistics retrieved successfully',
            data: {
                total_departments: totalDepartments,
                total_projects: totalProjects,
                total_products: totalProducts,
                total_source_files: 50, // TODO: Hardcoding for now, will need to implement later
            },
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
