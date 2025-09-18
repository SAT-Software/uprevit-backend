import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
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

        // Extract query parameters for pagination
        const limit = parseInt(event.queryStringParameters?.limit || '10');
        const page = parseInt(event.queryStringParameters?.page || '1');
        const sort = event.queryStringParameters?.sort || 'action_at';
        const statusParam = event.queryStringParameters?.status;
        const filter_param = event.queryStringParameters?.filter;
        const workspaceId = event.queryStringParameters?.workspace_id;
        const projectId = event.queryStringParameters?.project_id;

        // Validate required workspace_id parameter
        if (!workspaceId) {
            return ResponseWrapper.badRequest('workspace_id query parameter is required');
        }

        // Validate workspace_id format
        if (!ObjectId.isValid(workspaceId)) {
            return ResponseWrapper.badRequest('Invalid workspace_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate project_id format if provided
        if (projectId && !ObjectId.isValid(projectId)) {
            return ResponseWrapper.badRequest('Invalid project_id format. Must be a valid MongoDB ObjectId.');
        }

        // Default status filter: ['draft', 'submitted']
        const statusFilter = statusParam ? [statusParam] : ['draft', 'submitted'];

        // Validate pagination parameters
        if (limit < 1 || limit > 100) {
            return ResponseWrapper.badRequest('Limit must be between 1 and 100');
        }

        if (page < 1) {
            return ResponseWrapper.badRequest('Page must be greater than 0');
        }

        // Validate sort field
        const allowedSortFields = [
            'product_name',
            'product_plan_number',
            'master_version',
            'status',
            'target_date',
            'actual_completion_date',
            '_id',
            'action_at',
        ];
        if (!allowedSortFields.includes(sort)) {
            return ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`);
        }

        const skip = (page - 1) * limit;

        // Build filter - products with specified statuses
        const filter: any = {
            status: { $in: statusFilter }
        };

        // First, get project IDs that belong to the workspace
        const workspaceProjectIds = await db.collection('projects')
            .find({
                workspace_id: new ObjectId(workspaceId),
                isArchived: { $ne: true }
            })
            .project({ _id: 1 })
            .map(p => p._id)
            .toArray();

        // Get department IDs that belong to the workspace
        const workspaceDepartmentIds = await db.collection('departments')
            .find({
                workspace_id: new ObjectId(workspaceId),
                isArchived: { $ne: true }
            })
            .project({ _id: 1 })
            .map(d => d._id)
            .toArray();

        // Filter products by workspace through projects and departments
        filter.$or = [
            { project_id: { $in: workspaceProjectIds } },
            { department_id: { $in: workspaceDepartmentIds } }
        ];

        // Add project filter if provided
        if (projectId) {
            filter.project_id = new ObjectId(projectId);
            // Remove the $or filter since we're specifically filtering by project
            delete filter.$or;
        }

        // MongoDB projection to select specific fields
        const projection = {
            _id: 1,
            product_plan_number: 1,
            product_name: 1,
            project_id: 1,
            department_id: 1,
            master_version: 1,
            status: 1
        };

        // If sorting by action_at, use aggregation to join with audit_logs
        if (sort === 'action_at') {
            // aggregation pipeline
            const pipeline = [
                { $match: filter },
                {
                    $lookup: {
                        from: 'audit_log',
                        let: { productId: { $toString: '$_id' } },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $and: [
                                            { $eq: ['$entityId', '$$productId'] },
                                            { $eq: ['$entity', 'product'] },
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
                        action_at: {
                            $ifNull: [
                                { $arrayElemAt: ['$latestAuditLog.actionAt', 0] },
                                new Date(0), // Default to epoch if no audit log found
                            ],
                        },
                        action: {
                            $ifNull: [
                                { $arrayElemAt: ['$latestAuditLog.action', 0] },
                                null,
                            ],
                        },
                        action_by: {
                            $ifNull: [
                                { $arrayElemAt: ['$latestAuditLog.actionBy', 0] },
                                null,
                            ],
                        },
                    },
                },
                { $sort: { action_at: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                    $project: {
                        ...projection,
                        action: 1,
                        action_at: 1,
                        action_by: 1,
                        // latestAuditLog is not included, so it will be automatically excluded
                    },
                },
            ];

            // Get total count for pagination
            const countPipeline = [{ $match: filter }, { $count: 'total' }];

            const [products, countResult] = await Promise.all([
                db.collection<Product>('products').aggregate(pipeline).toArray(),
                db.collection<Product>('products').aggregate(countPipeline).toArray(),
            ]);

            const totalCount = countResult.length > 0 ? countResult[0].total : 0;
            const totalPages = Math.ceil(totalCount / limit);

            return ResponseWrapper.success({
                products,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalCount,
                    limit,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1,
                },
            });
        } else {
            // For other sort fields, use regular find with sort
            const sortObj: { [key: string]: 1 | -1 } = {};
            sortObj[sort] = 1;

            // Get total count based on filters
            const totalCount = await db.collection<Product>('products').countDocuments(filter);

            // Get paginated products based on filters with projection
            const products = await db
                .collection<Product>('products')
                .find(filter, { projection })
                .sort(sortObj)
                .skip(skip)
                .limit(limit)
                .toArray();

            // For non-action_at sort, we still need to fetch audit log info
            // Add audit log information for each product
            const productsWithAuditInfo = await Promise.all(
                products.map(async (product) => {
                    const auditLog = await db.collection('audit_log').findOne(
                        {
                            entityId: product._id!.toString(),
                            entity: 'product',
                            active: true
                        },
                        { sort: { actionAt: -1 } }
                    );

                    return {
                        ...product,
                        action: auditLog?.action || null,
                        action_at: auditLog?.actionAt || null,
                        action_by: auditLog?.actionBy || null,
                    };
                })
            );

            const totalPages = Math.ceil(totalCount / limit);

            return ResponseWrapper.success({
                products: productsWithAuditInfo,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalCount,
                    limit,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1,
                },
            });
        }
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};