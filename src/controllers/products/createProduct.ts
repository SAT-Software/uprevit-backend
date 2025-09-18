import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { Department } from '../../models/department';
import { Project } from '../../models/project';
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

type ProductInput = {
    _id?: string;
    product_plan_number: string;
    product_name: string;
    product_description: string;
    department_id: string;
    project_id: string;
    master_version?: string;
    status?: string;
    target_date?: string | null;
    actual_completion_date?: string | null;
    complete_count?: number;
    product_information?: {
        market_geography?: string;
        country_of_origin?: string;
        oem_contract_manufacturer?: string;
        commercial_clinical?: string;
        custom_fields?: Array<{
            _id?: string;
            field_name: string;
            field_value: string;
        }>;
        tab_completed?: boolean;
    };
    compliance_information?: {
        data?: Array<{
            _id?: string;
            compliance_type: string;
            status: string;
            reference_number?: string;
            notes?: string;
        }>;
        tab_completed?: boolean;
    };
    label_components?: {
        data?: Array<{
            _id?: string;
            component_name: string;
            component_type?: string;
            dimensions?: string;
            material?: string;
            color?: string;
        }>;
        tab_completed?: boolean;
    };
    symbols_graphics?: {
        data?: Array<{
            _id?: string;
            image: string;
            text: string;
            description?: string;
            text_present?: boolean;
            label_presence: string[];
            entity: 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components';
        }>;
        tab_completed?: boolean;
    };
    product_data?: {
        workbook_data?: any;
        tab_completed?: boolean;
    };
};

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        const input: ProductInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.product_plan_number || !input.product_name || !input.product_description || 
            !input.department_id || !input.project_id) {
            return ResponseWrapper.badRequest(
                'Missing required fields: product_plan_number, product_name, product_description, department_id, and project_id are required'
            );
        }

        // Validate ObjectId formats for department_id and project_id
        if (!ObjectId.isValid(input.department_id)) {
            return ResponseWrapper.badRequest('Invalid department_id format. Must be a valid MongoDB ObjectId.');
        }

        if (!ObjectId.isValid(input.project_id)) {
            return ResponseWrapper.badRequest('Invalid project_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate _id if provided
        if (input._id && !ObjectId.isValid(input._id)) {
            return ResponseWrapper.badRequest('Invalid _id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate status enum
        const validStatuses = ['draft', 'submitted', 'archive'];
        if (input.status && !validStatuses.includes(input.status)) {
            return ResponseWrapper.badRequest(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }

        // Validate entity enum in symbols_graphics
        if (input.symbols_graphics?.data) {
            const validEntities = ['Symbols', 'Schematics', 'Barcodes', 'Other Components'];
            for (const symbol of input.symbols_graphics.data) {
                if (!validEntities.includes(symbol.entity)) {
                    return ResponseWrapper.badRequest(`Invalid entity in symbols_graphics. Must be one of: ${validEntities.join(', ')}`);
                }
                if (!symbol.image || !symbol.text || !symbol.label_presence || !Array.isArray(symbol.label_presence)) {
                    return ResponseWrapper.badRequest('Each symbols_graphics item must have image, text, and label_presence array');
                }
            }
        }

        // Validate dates
        if (input.target_date) {
            const targetDate = new Date(input.target_date);
            if (isNaN(targetDate.getTime())) {
                return ResponseWrapper.badRequest('Invalid target_date format. Must be a valid ISO date string.');
            }
        }

        if (input.actual_completion_date) {
            const completionDate = new Date(input.actual_completion_date);
            if (isNaN(completionDate.getTime())) {
                return ResponseWrapper.badRequest('Invalid actual_completion_date format. Must be a valid ISO date string.');
            }
        }

        const db = await getDb();

        // Validate that department exists and is not archived
        const department = await db.collection<Department>('departments').findOne({
            _id: new ObjectId(input.department_id),
            isArchived: false
        });

        if (!department) {
            return ResponseWrapper.badRequest('Department not found or is archived');
        }

        // Validate that project exists, is not archived, and belongs to the department
        const project = await db.collection<Project>('projects').findOne({
            _id: new ObjectId(input.project_id),
            department_id: new ObjectId(input.department_id),
            isArchived: false
        });

        if (!project) {
            return ResponseWrapper.badRequest('Project not found, is archived, or does not belong to the specified department');
        }

        // Check if product_plan_number is unique
        const existingProduct = await db.collection<Product>('products').findOne({
            product_plan_number: input.product_plan_number
        });

        if (existingProduct) {
            return ResponseWrapper.badRequest('Product plan number already exists. Please use a unique product plan number.');
        }

        // Prepare the product object
        const productId = input._id ? new ObjectId(input._id) : new ObjectId();
        const departmentObjectId = new ObjectId(input.department_id);
        const projectObjectId = new ObjectId(input.project_id);

        // Process symbols_graphics with ObjectIds
        const processedSymbolsGraphics = (input.symbols_graphics?.data || []).map(symbol => ({
            _id: symbol._id ? new ObjectId(symbol._id) : new ObjectId(),
            image: symbol.image,
            text: symbol.text,
            description: symbol.description,
            text_present: symbol.text_present,
            label_presence: symbol.label_presence,
            entity: symbol.entity as 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components'
        }));

        // Process custom_fields with ObjectIds
        const processedCustomFields = (input.product_information?.custom_fields || []).map(field => ({
            _id: field._id ? new ObjectId(field._id) : new ObjectId(),
            field_name: field.field_name,
            field_value: field.field_value
        }));

        // Process compliance_information data with ObjectIds
        const processedComplianceData = (input.compliance_information?.data || []).map(item => ({
            _id: item._id ? new ObjectId(item._id) : new ObjectId(),
            compliance_type: item.compliance_type,
            status: item.status,
            reference_number: item.reference_number,
            notes: item.notes
        }));

        // Process label_components data with ObjectIds
        const processedLabelComponentsData = (input.label_components?.data || []).map(item => ({
            _id: item._id ? new ObjectId(item._id) : new ObjectId(),
            component_name: item.component_name,
            component_type: item.component_type,
            dimensions: item.dimensions,
            material: item.material,
            color: item.color
        }));

        const productData: Omit<Product, '_id'> & { _id: ObjectId } = {
            _id: productId,
            project_id: projectObjectId,
            department_id: departmentObjectId,
            product_plan_number: input.product_plan_number,
            product_name: input.product_name,
            product_description: input.product_description,
            master_version: input.master_version || '1.0',
            target_date: input.target_date ? new Date(input.target_date) : undefined,
            actual_completion_date: input.actual_completion_date ? new Date(input.actual_completion_date) : undefined,
            status: input.status || 'draft',
            complete_count: input.complete_count || 0,
            product_information: {
                market_geography: input.product_information?.market_geography || '',
                country_of_origin: input.product_information?.country_of_origin || '',
                oem_contract_manufacturer: input.product_information?.oem_contract_manufacturer || '',
                commercial_clinical: input.product_information?.commercial_clinical || '',
                custom_fields: processedCustomFields,
                tab_completed: input.product_information?.tab_completed || false
            },
            compliance_information: {
                data: processedComplianceData,
                tab_completed: input.compliance_information?.tab_completed || false
            },
            label_components: {
                data: processedLabelComponentsData,
                tab_completed: input.label_components?.tab_completed || false
            },
            symbols_graphics: {
                data: processedSymbolsGraphics,
                tab_completed: input.symbols_graphics?.tab_completed || false
            },
            product_data: {
                workbook_data: input.product_data?.workbook_data || {},
                tab_completed: input.product_data?.tab_completed || false
            }
        };

        // Insert the product
        const result = await db.collection<Product>('products').insertOne(productData);

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'product',
            entityId: result.insertedId.toString(),
            action: AuditLogAction.CREATE,
            actionBy: department.admin_id.toString(), // Use department admin as the creator
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Fetch the created product to return
        const createdProduct = await db.collection<Product>('products').findOne({
            _id: result.insertedId
        });

        return ResponseWrapper.created({
            message: 'Product created successfully',
            product: createdProduct,
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }
        
        // Handle MongoDB duplicate key errors
        if (err instanceof Error && err.message.includes('E11000')) {
            return ResponseWrapper.badRequest('Product with this plan number already exists');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};