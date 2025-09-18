import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';

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
            return ResponseWrapper.badRequest('workspace_id query parameter is required');
        }

        // Validate workspace_id format
        if (!ObjectId.isValid(workspaceId)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format');
        }

        const workspaceObjectId = new ObjectId(workspaceId);

        // Get all departments for this workspace
        const departments = await db.collection('departments')
            .find({
                workspace_id: workspaceObjectId,
                isArchived: { $ne: true }
            })
            .toArray();

        // Collect all unique user IDs from all departments
        const userIdsSet = new Set<string>();
        const adminUserIds = new Set<string>();

        departments.forEach(dept => {
            // Add admin as admin role
            if (dept.admin_id) {
                userIdsSet.add(dept.admin_id.toString());
                adminUserIds.add(dept.admin_id.toString());
            }
            // Add all department users as members
            if (dept.users && Array.isArray(dept.users)) {
                dept.users.forEach((userId: ObjectId) => {
                    userIdsSet.add(userId.toString());
                });
            }
        });

        // Convert to ObjectId array for MongoDB query
        const userObjectIds = Array.from(userIdsSet).map(id => new ObjectId(id));

        if (userObjectIds.length === 0) {
            return ResponseWrapper.success({
                data: []
            });
        }

        // Get all users
        const users = await db.collection('users')
            .find({
                _id: { $in: userObjectIds }
            })
            .project({
                _id: 1,
                name: 1,
                email: 1,
                profileAvatar: 1,
                designation: 1
            })
            .toArray();

        // Map users to the required format with role assignment
        const userData = users.map(user => ({
            _id: user._id.toString(),
            name: user.name,
            email: user.email,
            profileAvatar: user.profileAvatar,
            designation: user.designation,
            role: adminUserIds.has(user._id.toString()) ? 'admin' : 'member'
        }));

        return ResponseWrapper.success({
            data: userData
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};