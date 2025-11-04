import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateEnum, validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Create a product
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
					
		if(!auth.isValid) {
			return auth.error;
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		let input: Product;
			
		try {
			input = JSON.parse(event.body);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const missingFieldsResult = validateMissingFields({
			'project_id': input.project_id.toString(),
			'product_plan_number': input.product_plan_number,
			'product_name': input.product_name,
			'product_description': input.product_description,
			'status': input.status,
			'master_version': input.master_version,
		});

		if(missingFieldsResult) {
			return missingFieldsResult;
		}

		const enumValidation = validateEnum(['draft', 'submitted', 'archived'], input.status);
				
		if(enumValidation) {
			return enumValidation;
		}

		const objectIdValidation = validateObjectIds({
			'project_id': input.project_id,
			'department_id': input.department_id!,
		});

		if(objectIdValidation) {
			return objectIdValidation;
		}

		const db = await getDb();

		const projectObjectId = new ObjectId(input.project_id);
		const departmentObjectId = input.department_id ? new ObjectId(input.department_id) : undefined;

		// Check if product_plan_number already exists
		const existingProduct = await db.collection<Product>('products').findOne({
			product_plan_number: input.product_plan_number,
		});

		if (existingProduct) {
			return ResponseWrapper.conflict('Product plan number already exists');
		}

		// Set default values - use client data if provided, otherwise use defaults
		const productData = {
			project_id: projectObjectId,
			department_id: departmentObjectId,
			product_plan_number: input.product_plan_number,
			product_name: input.product_name,
			product_description: input.product_description,
			master_version: input.master_version,
			target_date: input.target_date || null,
			actual_completion_date: input.actual_completion_date || null,
			status: input.status,
			complete_count: input.complete_count || 0,
			product_information: input.product_information || {
				data: {
					_id: new ObjectId(),
					market_geography: '',
					country_of_origin: '',
					oem_contract_manufacturer: '',
					commercial_clinical: '',
					custom_fields: [],
				},
				tab_completed: false,
			},
			compliance_information: input.compliance_information || {
				data: [],
				tab_completed: false,
			},
			label_components: input.label_components || {
				data: [],
				tab_completed: false,
			},
			symbols_graphics: input.symbols_graphics || { data: [], tab_completed: false },
			product_data: input.product_data || {
				data: {
					_id: new ObjectId(),
					workbook_data: {},
				},
				tab_completed: false,
			},
			operational_parameters: input.operational_parameters || {
				data: {
					_id: new ObjectId(),
					workbook_data: {},
				},
				tab_completed: false,
			},
			label_tags: input.label_tags || {
				data: [],
				tab_completed: false,
			},
		};

		const product = await db.collection<Product>('products').insertOne(productData);

		await updateAuditLog({
			entity: 'product',
			entityId: product.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
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
