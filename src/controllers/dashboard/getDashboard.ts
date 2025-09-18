import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const db = await getDb();

        // Extract workspace_id from query parameters
        const workspaceId = event.queryStringParameters?.workspace_id;

        if (!workspaceId) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: 'workspace_id query parameter is required',
                }),
            };
        }

        // Validate workspace_id format
        if (!ObjectId.isValid(workspaceId)) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: 'Invalid workspace_id format',
                }),
            };
        }

        const workspaceObjectId = new ObjectId(workspaceId);

        // First get department and project IDs for the workspace
        const departmentIds = await db.collection('departments')
            .find({ workspace_id: workspaceObjectId, isArchived: { $ne: true } })
            .project({ _id: 1 })
            .map(d => d._id)
            .toArray();

        const projectIds = await db.collection('projects')
            .find({ workspace_id: workspaceObjectId, isArchived: { $ne: true } })
            .project({ _id: 1 })
            .map(p => p._id)
            .toArray();

        // Get counts for all entities related to the workspace
        const [departmentCount, projectCount, productCount, sourceFileCount] = await Promise.all([
            // Count departments in workspace
            Promise.resolve(departmentIds.length),

            // Count projects in workspace
            Promise.resolve(projectIds.length),

            // Count products in workspace (through projects and departments)
            db.collection('products').countDocuments({
                $or: [
                    { project_id: { $in: projectIds } },
                    { department_id: { $in: departmentIds } }
                ]
            }),

            // Count source files in workspace
            db.collection('source_files').countDocuments({
                workspace_id: workspaceObjectId
            })
        ]);

        const dashboardStats = {
            total_departments: departmentCount,
            total_projects: projectCount,
            total_products: productCount,
            total_source_files: sourceFileCount
        };

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Dashboard statistics fetched successfully',
                result: dashboardStats,
            }),
        };
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Internal server error',
                error: err instanceof Error ? err.message : 'Unknown error',
                timestamp: new Date().toISOString(),
            }),
        };
    }
};