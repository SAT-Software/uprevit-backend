import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Department } from '../../models/department';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
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
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        type DepartmentUpdateInput = {
            name?: string;
            description?: string;
            image?: string;
            manager?: string;
            admin_id: string;
            workspace_id: string;
            user_ids?: string[];
        };

        const input: DepartmentUpdateInput = JSON.parse(event.body);

        // Get department ID from path parameters
        const departmentId = event.pathParameters?.id;
        if (!departmentId) {
            return ResponseWrapper.badRequest('Department ID is required in path parameters');
        }

        // Validate department ID format
        if (!ObjectId.isValid(departmentId)) {
            return ResponseWrapper.badRequest('Invalid department ID format. Must be a valid MongoDB ObjectId.');
        }

        // Validate ObjectId formats for optional fields
        if (!ObjectId.isValid(input.admin_id)) {
            return ResponseWrapper.badRequest('Invalid admin_id format. Must be a valid MongoDB ObjectId.');
        }

        if (!ObjectId.isValid(input.workspace_id)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate user IDs if provided
        if (input.user_ids && input.user_ids.length > 0) {
            const invalidUserIds = input.user_ids.filter((userId) => !ObjectId.isValid(userId));
            if (invalidUserIds.length > 0) {
                return ResponseWrapper.badRequest(
                    `Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`,
                );
            }
        }

        const db = await getDb();

        const departmentRecord: Department | null = await db.collection<Department>('departments').findOne({
            _id: new ObjectId(departmentId),
        });

        if (!departmentRecord) {
            return ResponseWrapper.badRequest('Department not found');
        }

        // Build update object with only provided fields
        const updateFields: any = {};
        if (input.name !== undefined) updateFields.department_name = input.name;
        if (input.description !== undefined) updateFields.department_description = input.description;
        if (input.image !== undefined) updateFields.image = input.image;
        if (input.manager !== undefined) updateFields.manager = input.manager;
        if (input.admin_id !== undefined) updateFields.admin_id = new ObjectId(input.admin_id);
        if (input.workspace_id !== undefined) updateFields.workspace_id = new ObjectId(input.workspace_id);

        // Handle user_ids - fetch user details if provided
        let userObjects: any[] = [];
        if (input.user_ids !== undefined) {
            const userObjectIds = input.user_ids.map((userId) => new ObjectId(userId));
            updateFields.users = userObjectIds;

            if (input.user_ids.length > 0) {
                const users = await db.collection('users')
                    .find({
                        _id: { $in: userObjectIds }
                    })
                    .project({
                        _id: 1,
                        name: 1,
                        profileAvatar: 1,
                        designation: 1
                    })
                    .toArray();

                userObjects = users.map(user => ({
                    _id: user._id.toString(),
                    name: user.name,
                    profileAvatar: user.profileAvatar,
                    designation: user.designation
                }));
            }
        }

        const department = await db.collection<Department>('departments').updateOne(
            {
                _id: new ObjectId(departmentId),
            },
            {
                $set: updateFields,
            },
        );

        const auditRecord: AuditLog = {
            entity: 'department',
            entityId: departmentId,
            action: AuditLogAction.UPDATE,
            actionBy: input.admin_id || departmentRecord.admin_id.toString(),
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Get updated department record for response
        const updatedDepartment = await db.collection<Department>('departments').findOne({
            _id: new ObjectId(departmentId),
        });

        return ResponseWrapper.success({
            message: 'Department updated successfully',
            department: {
                _id: departmentId,
                name: updatedDepartment?.department_name,
                description: updatedDepartment?.department_description,
                image: updatedDepartment?.image,
                manager: updatedDepartment?.manager,
                admin_id: updatedDepartment?.admin_id.toString(),
                workspace_id: updatedDepartment?.workspace_id.toString(),
                users: input.user_ids !== undefined ? userObjects : undefined,
                isArchived: updatedDepartment?.isArchived
            }
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
