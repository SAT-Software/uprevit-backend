import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { ExcelData, LabelTags, Product, SymbolsGraphics, ProductInformation, ComplianceInformation, LabelComponents, ProductData } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds, validateEnum } from '../../utils/validationUtils';
import { authenticateRequest } from '../../utils/authUtils';
import { buildLegacyAuditLookupStage } from '../../utils/auditLogV2Aggregation';
import { enrichItemsWithSignedUrls } from '../../utils/s3-storage';

const enrichLabelComponentsWithSignedUrls = async (
	labelComponents: LabelComponents['data'],
): Promise<LabelComponents['data']> => {
	return enrichItemsWithSignedUrls({
		items: labelComponents,
		getKey: (item) => item.key,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			image: signedUrl,
		}),
	});
};

const enrichSymbolsGraphicsWithSignedUrls = async (
	symbolsGraphics: SymbolsGraphics['data'],
): Promise<SymbolsGraphics['data']> => {
	return enrichItemsWithSignedUrls({
		items: symbolsGraphics,
		getKey: (item) => item.key,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			image: signedUrl,
		}),
	});
};

const enrichLabelTagsWithSignedUrls = async (
	labelTags: LabelTags['data'],
): Promise<LabelTags['data']> => {
	const withImageUrls = await enrichItemsWithSignedUrls({
		items: labelTags,
		getKey: (item) => item.key,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			image: signedUrl,
		}),
	});

	return enrichItemsWithSignedUrls({
		items: withImageUrls,
		getKey: (item) => item.tagged_image_key,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			tagged_image: signedUrl,
		}),
	});
};

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
			buildLegacyAuditLookupStage({
				scopeType: 'product',
				updateActions: ['update', 'submit', 'delete', 'move', 'link', 'unlink', 'restore'],
			}),
		];

		const products = await db.collection<Product>('products').aggregate(pipeline).toArray();
		const product = products[0] as Product & { auditLogs: any[] };

		if (!product) {
			return ResponseWrapper.notFound('Product not found');
		}

		const auditLogs = product.auditLogs || [];
		const shouldEnrichLabelComponents = tab === 'all-tabs' || tab === 'label-components';
		const shouldEnrichSymbolsGraphics = tab === 'all-tabs' || tab === 'symbols-graphics';
		const shouldEnrichLabelTags = tab === 'all-tabs' || tab === 'label-tags';

		const labelComponentsData = shouldEnrichLabelComponents
			? await enrichLabelComponentsWithSignedUrls(product.label_components.data)
			: product.label_components.data;
		const symbolsGraphicsData = shouldEnrichSymbolsGraphics
			? await enrichSymbolsGraphicsWithSignedUrls(product.symbols_graphics.data)
			: product.symbols_graphics.data;
		const labelTagsData = shouldEnrichLabelTags
			? await enrichLabelTagsWithSignedUrls(product.label_tags.data)
			: product.label_tags.data;

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
					data: labelComponentsData,
					tab_completed: product.label_components.tab_completed,
				},
				symbols_graphics: {
					product_data: productData,
					data: symbolsGraphicsData,
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
					data: labelTagsData,
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
				data: labelComponentsData,
				tab_completed: product.label_components.tab_completed,
			};
			break;

		case 'symbols-graphics':
			tabData = {
				product_data: productData,
				data: symbolsGraphicsData,
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
				data: labelTagsData,
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
		if (err instanceof Error && err.message.includes('Missing required environment variable')) {
			logError('S3 configuration issue while signing product asset URLs', err);
		} else {
			logError('Get product data handler failed', err);
		}
		return ResponseWrapper.internalServerError('Failed to get product data');
	}
};
