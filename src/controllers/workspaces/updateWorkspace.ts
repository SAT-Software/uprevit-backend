import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
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

        const input: Workspace = JSON.parse(event.body);

        if (!input.workspaceName || !input._id) {
            return ResponseWrapper.badRequest('Missing required fields: _id, workspaceName are required');
        }

        // Validate ObjectId formats
        if (!ObjectId.isValid(input._id)) {
            return ResponseWrapper.badRequest('Invalid _id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate user IDs if provided
        if (input.userIds && input.userIds.length > 0) {
            const invalidUserIds = input.userIds.filter((userId) => !ObjectId.isValid(userId));
            if (invalidUserIds.length > 0) {
                return ResponseWrapper.badRequest(
                    `Invalid user IDs format: ${invalidUserIds.join(', ')}. Must be valid MongoDB ObjectIds.`,
                );
            }
        }

        const db = await getDb();

        const workspaceRecord: Workspace | null = await db.collection<Workspace>('workspaces').findOne({
            _id: new ObjectId(input._id),
        });

        if (!workspaceRecord) {
            return ResponseWrapper.badRequest('Workspace not found');
        }

        const userObjectIds = input.userIds ? input.userIds.map((userId) => new ObjectId(userId)) : [];

        const workspace = await db.collection<Workspace>('workspaces').updateOne(
            {
                _id: new ObjectId(workspaceRecord._id as ObjectId),
            },
            {
                $set: {
                    workspaceName: input.workspaceName,
                    companyName: input.companyName,
                    companyId: input.companyId,
                    description: input.description,
                    logo: input.logo,
                    plan: input.plan,
                    planId: input.planId,
                    planStart: input.planStart,
                    planEnd: input.planEnd,
                    cost: input.cost,
                    userIds: userObjectIds,
                },
            },
        );

        const auditRecord: AuditLog = {
            entity: 'workspace',
            entityId: (workspaceRecord._id as ObjectId).toString(),
            action: AuditLogAction.UPDATE,
            actionBy: (workspaceRecord._id as ObjectId).toString(),
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Workspace updated successfully',
            workspace: workspace,
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
