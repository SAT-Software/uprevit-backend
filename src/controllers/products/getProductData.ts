import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { ExcelData, LabelTags, Product, SymbolsGraphics, ProductInformation, ComplianceInformation, LabelComponents, ProductData } from '../../models/product';
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
			'product-specifications',
			'operational-parameters',
			'label-tags',
			'all-tabs',
		], tab);
				
		if(enumValidation) {
			return enumValidation;
		}

		const db = await getDb();
		const productObjectId = new ObjectId(productId);

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

		const products = await db.collection<Product>('products').aggregate(pipeline).toArray();
		const product = products[0] as Product & { auditLogs: any[] };

		if (!product) {
			return ResponseWrapper.notFound('Product not found');
		}

		const auditLogs = product.auditLogs || [];

		// Create product_data object once - reused across all tabs
		const productData: ProductData = {
			data: {
				_id: product._id,
				workspace_id: product.workspace_id,
				project_id: product.project_id,
				department_id: product.department_id,
				product_plan_number: product.product_plan_number,
				product_name: product.product_name,
				product_description: product.product_description,
				version: product.version,
				is_latest: product.is_latest,
				parent_id: product.parent_id,
				target_date: product.target_date ?? null,
				actual_completion_date: product.actual_completion_date ?? null,
				status: product.status,
				complete_count: product.complete_count,
			}
		};

		if (tab === 'all-tabs') {
			const allTabsData = {
				product_information: {
					product_data: productData,
					data: product.product_information.data,
					custom_fields: product.product_information.custom_fields,
					tab_completed: product.product_information.tab_completed,
				},
				compliance_information: {
					product_data: productData,
					data: product.compliance_information.data,
					tab_completed: product.compliance_information.tab_completed,
				},
				label_components: {
					product_data: productData,
					data: product.label_components.data,
					tab_completed: product.label_components.tab_completed,
				},
				symbols_graphics: {
					product_data: productData,
					data: product.symbols_graphics.data,
					tab_completed: product.symbols_graphics.tab_completed,
				},
				product_data: {
					product_data: productData,
					data: {
						_id: product.product_data.data._id,
						workbook_data: product.product_data.data.workbook_data,
					},
					tab_completed: product.product_data.tab_completed,
				},
				operational_parameters: {
					product_data: productData,
					data: {
						_id: product.operational_parameters.data._id,
						workbook_data: product.operational_parameters.data.workbook_data,
					},
					tab_completed: product.operational_parameters.tab_completed,
				},
				label_tags: {
					product_data: productData,
					data: product.label_tags.data,
					tab_completed: product.label_tags.tab_completed,
				},
			};

			return ResponseWrapper.success({
				message: 'Product data fetched successfully',
				result: {
					tab: tab,
					data: { ...allTabsData, auditLogs },
				},
			});
		}

		let tabData: ProductInformation | ComplianceInformation | LabelComponents | SymbolsGraphics | ExcelData | LabelTags;

		switch (tab) {
		case 'product-information':
			tabData = {
				product_data: productData,
				data: product.product_information.data,
				custom_fields: product.product_information.custom_fields,
				tab_completed: product.product_information.tab_completed,
			};
			break;

		case 'compliance-information':
			tabData = {
				product_data: productData,
				data: product.compliance_information.data,
				tab_completed: product.compliance_information.tab_completed,
			};
			break;

		case 'label-components':
			tabData = {
				product_data: productData,
				data: product.label_components.data,
				tab_completed: product.label_components.tab_completed,
			};
			break;

		case 'symbols-graphics':
			tabData = {
				product_data: productData,
				data: product.symbols_graphics.data,
				tab_completed: product.symbols_graphics.tab_completed,
			};
			break;

		case 'product-specifications':
			tabData = {
				product_data: productData,
				data: {
					_id: product.product_data.data._id,
					workbook_data: product.product_data.data.workbook_data,
				},
				tab_completed: product.product_data.tab_completed,
			};
			break;

		case 'operational-parameters':
			tabData = {
				product_data: productData,
				data: {
					_id: product.operational_parameters.data._id,
					workbook_data: product.operational_parameters.data.workbook_data,
				},
				tab_completed: product.operational_parameters.tab_completed,
			};
			break;

		case 'label-tags':
			tabData = {
				product_data: productData,
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
				data: { ...tabData, auditLogs },
			},
		});
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
