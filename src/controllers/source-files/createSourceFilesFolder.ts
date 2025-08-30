import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { SourceFiles } from '../../models/sourceFiles';
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

        type CreateSourceFilesFolderInput = {
            product_id: string;
            name: string;
        };

        const input: CreateSourceFilesFolderInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.product_id || !input.name) {
            return ResponseWrapper.badRequest(
                'Missing required fields: product_id and name are required'
            );
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(input.product_id)) {
            return ResponseWrapper.badRequest('Invalid product_id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate folder name (basic validation)
        if (input.name.trim().length === 0) {
            return ResponseWrapper.badRequest('Folder name cannot be empty');
        }

        if (input.name.length > 100) {
            return ResponseWrapper.badRequest('Folder name cannot exceed 100 characters');
        }

        const db = await getDb();

        // Check if product exists and is active
        const product: Product | null = await db.collection<Product>('products').findOne({
            _id: new ObjectId(input.product_id),
            isActive: true
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found or is not active');
        }

        // Get workspace_id from product's project context
        // First, find the project to get the department
        const project = await db.collection('projects').findOne({
            _id: product.project_id,
            isArchived: false
        });

        if (!project) {
            return ResponseWrapper.badRequest('Associated project not found or is archived');
        }

        // Find the department to get workspace_id (assuming department has workspace_id)
        const department = await db.collection('departments').findOne({
            _id: project.department_id,
            isArchived: false
        });

        if (!department) {
            return ResponseWrapper.badRequest('Associated department not found or is archived');
        }

        // Check if folder name already exists for this product
        const existingFolder = await db.collection<SourceFiles>('sourceFiles').findOne({
            product_id: new ObjectId(input.product_id),
            folder_name: input.name.trim()
        });

        if (existingFolder) {
            return ResponseWrapper.badRequest('A folder with this name already exists for this product');
        }

        // Create the source files folder
        const sourceFilesData: Omit<SourceFiles, '_id'> & { _id: ObjectId } = {
            _id: new ObjectId(),
            folder_name: input.name.trim(),
            product_id: new ObjectId(input.product_id),
            workspace_id: department.workspace_id || new ObjectId(), // Fallback to new ObjectId if not available
            folder: []
        };

        // Insert the source files folder
        const result = await db.collection<SourceFiles>('sourceFiles').insertOne(sourceFilesData);

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'sourceFiles',
            entityId: result.insertedId.toString(),
            action: AuditLogAction.CREATE,
            actionBy: department.admin_id?.toString() || 'system',
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Prepare response data matching the required format
        const responseData = {
            _id: result.insertedId,
            folder_name: sourceFilesData.folder_name,
            product_id: sourceFilesData.product_id,
            workspace_id: sourceFilesData.workspace_id,
            folder: sourceFilesData.folder,
            action_by: department.admin_id?.toString() || 'system',
            action_at: new Date()
        };

        return ResponseWrapper.created({
            message: 'Source files folder created successfully',
            sourceFilesFolder: responseData,
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }
        
        // Handle MongoDB duplicate key errors
        if (err instanceof Error && err.message.includes('E11000')) {
            return ResponseWrapper.badRequest('Source files folder with this name already exists for this product');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};