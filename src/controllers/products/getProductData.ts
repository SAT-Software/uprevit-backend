import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { ExcelData, LabelTags, Product, SymbolsGraphics, ProductInformation, ComplianceInformation, LabelComponents } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateEnum } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';

/**
 * Get product data
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
	    
		const auth = await authenticateRequest(event);

		if(!auth.isValid) {
			return auth.error;
		}

		// Extract query parameters
		const productId = event.queryStringParameters?.id;
		const tab = event.queryStringParameters?.tab;

		if (!productId) {
			return ResponseWrapper.badRequest("Product id - 'id' is required in query parameters");
		}

		if (!tab) {
			return ResponseWrapper.badRequest("Product data tab - 'tab' is required in query parameters");
		}

		const validationResult = validateAllObjectIds({
			'_id': productId,
		});

		if (validationResult) {
			return validationResult;
		}

		const enumValidation = validateEnum([
			'product-information',
			'compliance-information',
			'label-components',
			'symbols-graphics',
			'product-data',
			'operational-parameters',
			'label-tags',
			'all-tabs',
		], tab);
				
		if(enumValidation) {
			return enumValidation;
		}

		const db = await getDb();
		const productObjectId = new ObjectId(productId);

		// Build aggregation pipeline with audit log lookup
		const pipeline = [
			{ $match: { _id: productObjectId } },
			{
				$lookup: {
					from: 'audit_log',
					let: { productIdString: { $toString: '$_id' } },
					pipeline: [
						{
							$match: {
								$expr: {
									$and: [
										{ $eq: ['$entity', 'product'] },
										{ $eq: ['$entityId', '$$productIdString'] },
										{ $in: ['$action', ['create', 'update']] },
										{ $eq: ['$active', true] }
									]
								}
							}
						},
						{ $sort: { actionAt: -1 } },
						{
							$project: {
								entity: 1,
								entityId: 1,
								action: 1,
								actionBy: 1,
								actionAt: 1,
								active: 1
							}
						},
						{ $limit: 2 }
					],
					as: 'auditLogs'
				}
			}
		];

		// Find the product with audit logs
		const products = await db.collection<Product>('products').aggregate(pipeline).toArray();
		const product = products[0] as Product & { auditLogs: any[] };

		if (!product) {
			return ResponseWrapper.notFound('Product not found');
		}

		const auditLogs = product.auditLogs || [];

		// Handle all-tabs case separately to maintain type safety
		if (tab === 'all-tabs') {
			const allTabsData = {
				product_information: {
					data: { ...product.product_information.data },
					tab_completed: product.product_information.tab_completed,
				},
				compliance_information: {
					data: product.compliance_information.data,
					tab_completed: product.compliance_information.tab_completed,
				},
				label_components: {
					data: product.label_components.data,
					tab_completed: product.label_components.tab_completed,
				},
				symbols_graphics: {
					data: product.symbols_graphics.data,
					tab_completed: product.symbols_graphics.tab_completed,
				},
				product_data: {
					data: {
						_id: product.product_data.data._id,
						workbook_data: product.product_data.data.workbook_data,
					},
					tab_completed: product.product_data.tab_completed,
				},
				operational_parameters: {
					data: {
						_id: product.operational_parameters.data._id,
						workbook_data: product.operational_parameters.data.workbook_data,
					},
					tab_completed: product.operational_parameters.tab_completed,
				},
				label_tags: {
					data: product.label_tags.data,
					tab_completed: product.label_tags.tab_completed,
				},
			};

			return ResponseWrapper.success({
				message: 'Product data fetched successfully',
				result: {
					tab: tab,
					data: {...allTabsData, auditLogs},
				},
			});
		}

		// Extract data for individual tabs
		let tabData: ProductInformation | ComplianceInformation | LabelComponents | SymbolsGraphics | ExcelData | LabelTags;

		switch (tab) {
		case 'product-information':
			tabData = {
				data: { ...product.product_information.data,product_name: product.product_name, product_plan_number: product.product_plan_number, product_description: product.product_description, status: product.status, target_date: product.target_date ?? null, actual_completion_date: product.actual_completion_date ?? null, custom_fields: product.product_information.custom_fields },
				tab_completed: product.product_information.tab_completed,
			};
			break;

		case 'compliance-information':
			tabData = {
				data: product.compliance_information.data,
				tab_completed: product.compliance_information.tab_completed,
			};
			break;

		case 'label-components':
			tabData = {
				data: product.label_components.data,
				tab_completed: product.label_components.tab_completed,
			};
			break;

		case 'symbols-graphics':
			tabData = {
				data: product.symbols_graphics.data,
				tab_completed: product.symbols_graphics.tab_completed,
			};
			break;

		case 'product-data':
			tabData = {
				data: {
					_id: product.product_data.data._id,
					workbook_data: product.product_data.data.workbook_data,
				},
				tab_completed: product.product_data.tab_completed,
			};
			break;

		case 'operational-parameters':
			tabData = {
				data: {
					_id: product.operational_parameters.data._id,
					workbook_data: product.operational_parameters.data.workbook_data,
				},
				tab_completed: product.operational_parameters.tab_completed,
			};
			break;

		case 'label-tags':
			tabData = {
				data: product.label_tags.data,
				tab_completed: product.label_tags.tab_completed,
			};
			break;

		default:
			return ResponseWrapper.badRequest(`Unknown tab: ${tab}`);
		}

		return ResponseWrapper.success({
			message: 'Product data fetched successfully',
			result: {
				tab: tab,
				data: {...tabData, auditLogs},
			},
		});
	} catch (err) {
	    console.error('Error in Lambda handler:', err);
	    return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
