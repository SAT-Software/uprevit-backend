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
        const db = await getDb();

        // Extract query parameters
        const limit = parseInt(event.queryStringParameters?.limit || '25');
        const page = parseInt(event.queryStringParameters?.page || '1');
        const sort = event.queryStringParameters?.sort || '_id';
        const workspaceId = event.queryStringParameters?.workspace_id;
        const departmentId = event.queryStringParameters?.department_id;

        // Validate required workspace_id parameter
        if (!workspaceId) {
            return ResponseWrapper.badRequest('workspace_id query parameter is required');
        }

        // Validate workspace_id format
        if (!ObjectId.isValid(workspaceId)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate department_id format if provided
        if (departmentId && !ObjectId.isValid(departmentId)) {
            return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate pagination parameters
        if (limit < 1 || limit > 100) {
            return ResponseWrapper.badRequest('Limit must be between 1 and 100');
        }

        if (page < 1) {
            return ResponseWrapper.badRequest('Page must be greater than 0');
        }

        // Validate sort field
        const allowedSortFields = [
            'name',
            'description',
            'manager',
            '_id',
            'actionAt',
        ];
        if (!allowedSortFields.includes(sort)) {
            return ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`);
        }

        const skip = (page - 1) * limit;

        // Build filter object
        const filter: any = {
            workspace_id: new ObjectId(workspaceId),
            isArchived: { $ne: true }
        };

        // Add department filter if provided
        if (departmentId) {
            filter.department_id = new ObjectId(departmentId);
        }

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

            // Transform projects to match required format
            const transformedProjects = projects.map(project => ({
                _id: project._id.toString(),
                name: project.project_name,
                description: project.project_description,
                department_id: project.department_id.toString(),
                workspace_id: project.workspace_id.toString(),
                manager: project.manager,
                admin_id: project.admin_id.toString(),
                isArchived: project.isArchived
            }));

            return ResponseWrapper.success({
                data: transformedProjects,
                pagination: {
                    current_page: page,
                    total_pages: totalPages,
                    limit,
                    total_count: totalCount,
                    has_next_page: page < totalPages,
                    has_prev_page: page > 1,
                },
            });
        } else {
            // For other sort fields, use regular find with sort
            const sortObj: { [key: string]: 1 | -1 } = {};

            // Map API sort fields to database fields
            const sortFieldMap: { [key: string]: string } = {
                'name': 'project_name',
                'description': 'project_description',
                'manager': 'manager',
                '_id': '_id'
            };

            const dbSortField = sortFieldMap[sort] || sort;
            sortObj[dbSortField] = 1;

            // Get total count based on filter
            const totalCount = await db.collection<Project>('projects').countDocuments(filter);

            // Get paginated projects based on filter
            const projects = await db
                .collection<Project>('projects')
                .find(filter)
                .sort(sortObj)
                .skip(skip)
                .limit(limit)
                .toArray();

            const totalPages = Math.ceil(totalCount / limit);

            // Transform projects to match required format
            const transformedProjects = projects.map(project => ({
                _id: project._id.toString(),
                name: project.project_name,
                description: project.project_description,
                department_id: project.department_id.toString(),
                workspace_id: project.workspace_id.toString(),
                manager: project.manager,
                admin_id: project.admin_id.toString(),
                isArchived: project.isArchived
            }));

            return ResponseWrapper.success({
                data: transformedProjects,
                pagination: {
                    current_page: page,
                    total_pages: totalPages,
                    limit,
                    total_count: totalCount,
                    has_next_page: page < totalPages,
                    has_prev_page: page > 1,
                },
            });
        }
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
