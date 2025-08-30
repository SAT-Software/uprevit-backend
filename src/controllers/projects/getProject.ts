import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Project } from '../../models/project';
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
        const projectId = event.pathParameters?.id;

        if (!projectId) {
            return ResponseWrapper.badRequest('Missing required path parameter: id');
        }

        if (!ObjectId.isValid(projectId)) {
            return ResponseWrapper.badRequest('Invalid project ID format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        const pipeline = [
            { $match: { _id: new ObjectId(projectId), isArchived: { $ne: true } } },
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
                            new Date(0), 
                        ],
                    },
                },
            },
            {
                $project: {
                    latestAuditLog: 0,
                },
            },
        ];

        const projects = await db.collection<Project>('projects').aggregate(pipeline).toArray();

        if (projects.length === 0) {
            return ResponseWrapper.notFound('Project not found');
        }

        return ResponseWrapper.success({
            message: 'Project fetched successfully',
            project: projects[0],
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};