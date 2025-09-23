import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateRole } from '../../utils/authUtils';

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

        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        const token = authHeader.split(' ')[1];
        const { isValid, payload } = await validateRole(token, 'admin');
        if (!isValid) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        const input: Product = JSON.parse(event.body);

        // Validate required fields
        if (!input.project_id || !input.product_plan_number || !input.product_name || !input.product_description) {
            return ResponseWrapper.badRequest(
                'Missing required fields: project_id, product_plan_number, product_name, and product_description are required',
            );
        }

        // Validate ObjectId formats
        if (!ObjectId.isValid(input.project_id)) {
            return ResponseWrapper.badRequest('Invalid project_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate department_id if provided
        if (input.department_id && !ObjectId.isValid(input.department_id)) {
            return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        const projectObjectId = new ObjectId(input.project_id);
        const departmentObjectId = input.department_id ? new ObjectId(input.department_id) : undefined;

        // Check if product_plan_number already exists
        const existingProduct = await db.collection<Product>('products').findOne({
            product_plan_number: input.product_plan_number,
            isActive: { $ne: false },
        });

        if (existingProduct) {
            return ResponseWrapper.conflict('Product plan number already exists');
        }

        // Set default values
        const productData = {
            project_id: projectObjectId,
            department_id: departmentObjectId,
            product_plan_number: input.product_plan_number,
            product_name: input.product_name,
            product_description: input.product_description,
            master_version: input.master_version || '1.0',
            isActive: input.isActive !== undefined ? input.isActive : true,
            target_date: input.target_date || null,
            actual_completion_date: input.actual_completion_date || null,
            status: input.status || 'draft',
            complete_count: input.complete_count || 0,
            product_information: {
                market_geography: input.product_information?.market_geography || '',
                country_of_origin: input.product_information?.country_of_origin || '',
                oem_contract_manufacturer: input.product_information?.oem_contract_manufacturer || '',
                commercial_clinical: input.product_information?.commercial_clinical || '',
                custom_fields: input.product_information?.custom_fields || [],
                tab_completed: input.product_information?.tab_completed || false,
            },
            compliance_information: {
                data: input.compliance_information?.data || [],
                tab_completed: input.compliance_information?.tab_completed || false,
            },
            label_components: {
                data: input.label_components?.data || [],
                tab_completed: input.label_components?.tab_completed || false,
            },
            symbols_graphics: input.symbols_graphics || [],
        };

        const product = await db.collection<Product>('products').insertOne(productData);

        await updateAuditLog({
            entity: 'product',
            entityId: product.insertedId.toString(),
            action: AuditLogAction.CREATE,
            actionBy: payload?.name?.toString()!,
            actionAt: new Date(),
            active: true,
        });

        return ResponseWrapper.created({
            message: 'Product created successfully',
            product: product,
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
