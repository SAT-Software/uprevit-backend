import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { ObjectId } from 'mongodb';
import { authenticateRequest } from '../../utils/authUtils';
import {
	addCustomField,
	deleteCustomField,
	updateCustomField,
	updateProductInformation,
	updateProductInfoTabCompletion,
} from './productData/product-info';
import { UpdateProductDataRequest } from '../../types/products/all-update-product-data';
import { addComplianceStandard, deleteComplianceStandard, updateComplianceStandard, updateComplianceTabCompletion } from './productData/compliance-standard';
import { addLabelComponent, deleteLabelComponent, updateLabelComponent, updateLabelComponentTabCompletion } from './productData/label-components';
import { updateLanguagesInformation } from './productData/languages';
import { AddStandardSymbolsGraphics, AddSymbolsGraphics, deleteSymbolsGraphics, UpdateSymbolsGraphics, updateSymbolsGraphicsTabCompletion } from './productData/symbols-graphics';
import { addProductData, deleteProductData, updateProductData, updateProductDataTabCompletion } from './productData/product-data';
import { addOperationalParameters, deleteOperationalParameters, updateOperationalParameters, updateOperationalParametersTabCompletion } from './productData/operational-parameters';
import { addLabelTag, deleteLabelTag, updateLabelTag, updateLabelTagsTabCompletion, updateLabelTagTaggedImage, updateLabelTagLegend } from './productData/label-tags';
import { SymbolsGraphics } from '../../types/products/symbols-graphics';
import { recordAuditEvent } from '../../utils/auditLogV2';

const validTabs = [
	'product-information',
	'compliance-information',
	'languages-information',
	'label-components',
	'symbols-graphics',
	'product-specifications',
	'operational-parameters',
	'label-tags',
];

type ProductDataAuditMeta = {
	eventKey: string;
	action: 'create' | 'update' | 'delete';
	changedPaths: string[];
};

const PRODUCT_DATA_ACTION_AUDIT_META: Record<string, ProductDataAuditMeta> = {
	update_product_information: {
		eventKey: 'product.product_information.updated',
		action: 'update',
		changedPaths: [
			'product_name',
			'product_plan_number',
			'product_description',
			'target_date',
			'actual_completion_date',
			'product_information.data.market_geography',
			'product_information.data.country_of_origin',
			'product_information.data.oem_contract_manufacturer',
			'product_information.data.commercial_clinical',
			'product_information.data.manufacturing_location',
		],
	},
	add_custom_field: {
		eventKey: 'product.product_information.custom_field.added',
		action: 'create',
		changedPaths: ['product_information.custom_fields'],
	},
	update_custom_field: {
		eventKey: 'product.product_information.custom_field.updated',
		action: 'update',
		changedPaths: ['product_information.custom_fields'],
	},
	delete_custom_field: {
		eventKey: 'product.product_information.custom_field.deleted',
		action: 'delete',
		changedPaths: ['product_information.custom_fields'],
	},
	update_product_information_completion: {
		eventKey: 'product.product_information.completion.updated',
		action: 'update',
		changedPaths: ['product_information.tab_completed'],
	},
	add_compliance_standard: {
		eventKey: 'product.compliance_item.added',
		action: 'create',
		changedPaths: ['compliance_information.data'],
	},
	update_compliance_standard: {
		eventKey: 'product.compliance_item.updated',
		action: 'update',
		changedPaths: ['compliance_information.data'],
	},
	delete_compliance_standard: {
		eventKey: 'product.compliance_item.deleted',
		action: 'delete',
		changedPaths: ['compliance_information.data'],
	},
	update_compliance_tab_completion: {
		eventKey: 'product.compliance_information.completion.updated',
		action: 'update',
		changedPaths: ['compliance_information.tab_completed'],
	},
	update_languages_information: {
		eventKey: 'product.languages_information.updated',
		action: 'update',
		changedPaths: ['languages_information.data'],
	},
	add_label_component: {
		eventKey: 'product.label_component.added',
		action: 'create',
		changedPaths: ['label_components.data'],
	},
	update_label_component: {
		eventKey: 'product.label_component.updated',
		action: 'update',
		changedPaths: ['label_components.data'],
	},
	delete_label_component: {
		eventKey: 'product.label_component.deleted',
		action: 'delete',
		changedPaths: ['label_components.data'],
	},
	update_label_component_tab_completion: {
		eventKey: 'product.label_components.completion.updated',
		action: 'update',
		changedPaths: ['label_components.tab_completed'],
	},
	add_symbols_graphics: {
		eventKey: 'product.symbol_graphic.added',
		action: 'create',
		changedPaths: ['symbols_graphics.data'],
	},
	add_standard_symbols_graphics: {
		eventKey: 'product.symbol_graphic.added',
		action: 'create',
		changedPaths: ['symbols_graphics.data'],
	},
	update_symbols_graphics: {
		eventKey: 'product.symbol_graphic.updated',
		action: 'update',
		changedPaths: ['symbols_graphics.data'],
	},
	delete_symbols_graphics: {
		eventKey: 'product.symbol_graphic.deleted',
		action: 'delete',
		changedPaths: ['symbols_graphics.data'],
	},
	update_symbols_graphics_tab_completion: {
		eventKey: 'product.symbol_graphics.completion.updated',
		action: 'update',
		changedPaths: ['symbols_graphics.tab_completed'],
	},
	add_product_data: {
		eventKey: 'product.product_specification.added',
		action: 'create',
		changedPaths: ['product_data.data.workbook_data'],
	},
	update_product_data: {
		eventKey: 'product.product_specification.updated',
		action: 'update',
		changedPaths: ['product_data.data.workbook_data'],
	},
	delete_product_data: {
		eventKey: 'product.product_specification.deleted',
		action: 'delete',
		changedPaths: ['product_data.data'],
	},
	update_product_data_tab_completion: {
		eventKey: 'product.product_specifications.completion.updated',
		action: 'update',
		changedPaths: ['product_data.tab_completed'],
	},
	add_operational_parameters: {
		eventKey: 'product.operational_parameter.added',
		action: 'create',
		changedPaths: ['operational_parameters.data.workbook_data'],
	},
	update_operational_parameters: {
		eventKey: 'product.operational_parameter.updated',
		action: 'update',
		changedPaths: ['operational_parameters.data.workbook_data'],
	},
	delete_operational_parameters: {
		eventKey: 'product.operational_parameter.deleted',
		action: 'delete',
		changedPaths: ['operational_parameters.data'],
	},
	update_operational_parameters_tab_completion: {
		eventKey: 'product.operational_parameters.completion.updated',
		action: 'update',
		changedPaths: ['operational_parameters.tab_completed'],
	},
	add_label_tags: {
		eventKey: 'product.label_tag.added',
		action: 'create',
		changedPaths: ['label_tags.data'],
	},
	update_label_tags: {
		eventKey: 'product.label_tag.updated',
		action: 'update',
		changedPaths: ['label_tags.data'],
	},
	delete_label_tags: {
		eventKey: 'product.label_tag.deleted',
		action: 'delete',
		changedPaths: ['label_tags.data'],
	},
	update_label_tag_tagged_image: {
		eventKey: 'product.label_tag.tagged_image.updated',
		action: 'update',
		changedPaths: ['label_tags.data'],
	},
	update_label_tag_legend: {
		eventKey: 'product.label_tag.legend.updated',
		action: 'update',
		changedPaths: ['label_tags.data'],
	},
	update_label_tags_tab_completion: {
		eventKey: 'product.label_tags.completion.updated',
		action: 'update',
		changedPaths: ['label_tags.tab_completed'],
	},
};

/**
 * Update product data (generic PATCH endpoint)
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	const auth = await authenticateRequest(event);

	if (!auth.isValid) return auth.error;

	try {
		if (!event.body) return ResponseWrapper.badRequest('Request body is required to update product data');

		const input: UpdateProductDataRequest = JSON.parse(event.body);

		const missingFields = validateMissingFields({
			id: input.id,
			tab: input.tab,
			action: input.action,
		});

		if (missingFields) return missingFields;

		const objectIdValidation = validateAllObjectIds({
			_id: input.id!,
		});

		if (objectIdValidation) return objectIdValidation;

		if (!validTabs.includes(input.tab))
			return ResponseWrapper.badRequest(`Invalid tab parameter. Must be one of: ${validTabs.join(', ')}`);

		const db = await getDb();

		const product = await db.collection<Product>('products').findOne({ _id: new ObjectId(input.id) });

		if (!product) return ResponseWrapper.notFound('Product not found, please check the provided product id.');

		let updateQuery = {};
		let updatedData = {};
		let skipUpdate = false;

		switch (input.action) {
		case 'update_product_information':
			const result = updateProductInformation(input.data, input.tab, input.action);
			if (result.error) return result.error;

			({ updateQuery, updatedData } = result);

			break;

		case 'add_custom_field':
			const addCustomFieldResult = addCustomField(input.data, input.tab, input.action);
			if (addCustomFieldResult.error) return addCustomFieldResult.error;

			({ updateQuery, updatedData } = addCustomFieldResult);

			break;

		case 'update_custom_field':
			const updateCustomFieldResult = updateCustomField(
				input.data,
				input.tab,
				input.action,
				product.product_information.custom_fields || [],
			);
			if (updateCustomFieldResult.error) return updateCustomFieldResult.error;

			({ updateQuery, updatedData } = updateCustomFieldResult);

			break;

		case 'delete_custom_field':
			const deleteCustomFieldResult = deleteCustomField(input.data, input.tab, input.action);
			if (deleteCustomFieldResult.error) return deleteCustomFieldResult.error;

			({ updateQuery, updatedData } = deleteCustomFieldResult);

			break;

		case 'update_product_information_completion':
			const updateTabCompletionResult = updateProductInfoTabCompletion(input.data, input.tab, input.action);
			if (updateTabCompletionResult.error) return updateTabCompletionResult.error;

			({ updateQuery, updatedData } = updateTabCompletionResult);

			break;

		case 'add_compliance_standard':
			const addComplianceStandardResult = addComplianceStandard(input.data, input.tab, input.action);
			if (addComplianceStandardResult.error) return addComplianceStandardResult.error;

			({ updateQuery, updatedData } = addComplianceStandardResult);

			break;

		case 'update_compliance_standard':
			const updateComplianceStandardResult = updateComplianceStandard(input.data, input.tab, input.action);
			if (updateComplianceStandardResult.error) return updateComplianceStandardResult.error;

			({ updateQuery, updatedData } = updateComplianceStandardResult);

			break;

		case 'delete_compliance_standard':
			const deleteComplianceStandardResult = deleteComplianceStandard(input.data, input.tab, input.action);
			if (deleteComplianceStandardResult.error) return deleteComplianceStandardResult.error;

			({ updateQuery } = deleteComplianceStandardResult);
			updatedData = input.data;

			break;

		case 'update_compliance_tab_completion':
			const updateComplianceTabCompletionResult = updateComplianceTabCompletion(input.data, input.tab, input.action);
			if (updateComplianceTabCompletionResult.error) return updateComplianceTabCompletionResult.error;

			({ updateQuery, updatedData } = updateComplianceTabCompletionResult);

			break;

		case 'update_languages_information':
			const updateLanguagesInformationResult = updateLanguagesInformation(input.data, input.tab, input.action);
			if (updateLanguagesInformationResult.error) return updateLanguagesInformationResult.error;

			({ updateQuery, updatedData } = updateLanguagesInformationResult);

			break;

		case 'add_label_component':
			const addLabelComponentResult = addLabelComponent(input.data, input.tab, input.action);
			if (addLabelComponentResult.error) return addLabelComponentResult.error;

			const isDuplicateAddLabelComponent = await db.collection<Product>('products').findOne({
				_id: new ObjectId(input.id),
				'label_components.data.component_number': input.data[0].component_number,
			});
			if (isDuplicateAddLabelComponent) return ResponseWrapper.conflict('Component number already exists, please use a different component number.');

			({ updateQuery, updatedData } = addLabelComponentResult);

			break;

		case 'update_label_component':
			const updateLabelComponentResult = updateLabelComponent(input.data, input.tab, input.action);
			if (updateLabelComponentResult.error) return updateLabelComponentResult.error;

			const isDuplicateUpdateLabelComponent = await db.collection<Product>('products').findOne({
				_id: new ObjectId(input.id),
				'label_components.data': {
					$elemMatch: {
						_id: {$ne: new ObjectId(input.data.id)},
						component_number: input.data.component_number,
					}		
				}
			});
			if (isDuplicateUpdateLabelComponent) return ResponseWrapper.conflict('Component number already exists, please use a different component number.');

			({ updateQuery, updatedData } = updateLabelComponentResult);

			break;

		case 'delete_label_component':
			const deleteLabelComponentResult = deleteLabelComponent(input.data, input.tab, input.action);
			if (deleteLabelComponentResult.error) return deleteLabelComponentResult.error;

			({ updateQuery, updatedData } = deleteLabelComponentResult);

			break;

		case 'update_label_component_tab_completion':
			const updateLabelComponentTabCompletionResult = updateLabelComponentTabCompletion(input.data, input.tab, input.action);
			if (updateLabelComponentTabCompletionResult.error) return updateLabelComponentTabCompletionResult.error;

			({ updateQuery, updatedData } = updateLabelComponentTabCompletionResult);

			break;
		case 'add_symbols_graphics': {
			const addSymbolsGraphicsResult = AddSymbolsGraphics(input.data, input.tab, input.action);
			if (addSymbolsGraphicsResult.error) return addSymbolsGraphicsResult.error;

			const entity = input.data[0].entity?.toLowerCase();
			if(entity === 'barcodes') {
				const isDuplicateBarcode = await db.collection<Product>('products').findOne({
					_id: new ObjectId(input.id),
					'symbols_graphics.data': {
						$elemMatch: {
							entity: 'Barcodes',
							text: input.data[0].text,
							description: input.data[0].description,
						}
					}
				});
				if (isDuplicateBarcode) return ResponseWrapper.conflict('Barcode description already exists, please use a different barcode description.');
			} else if (entity !== 'other components') {
				const isDuplicategraphics = await db.collection<Product>('products').findOne({
					_id: new ObjectId(input.id),
					'symbols_graphics.data': {
						$elemMatch:{
							entity: input.data[0].entity,
							text: input.data[0].text,
						}
					}
				});
				if (isDuplicategraphics) return ResponseWrapper.conflict('Graphics description already exists, please use a different graphics description.');
			}

			({ updateQuery, updatedData } = addSymbolsGraphicsResult);

			break;
		}

		case 'add_standard_symbols_graphics': {
			const addStandardSymbolsGraphicsResult = await AddStandardSymbolsGraphics(
				input.data,
				input.tab,
				input.action,
				product.symbols_graphics.data,
			);
			if (addStandardSymbolsGraphicsResult.error) return addStandardSymbolsGraphicsResult.error;

			({ updateQuery, updatedData } = addStandardSymbolsGraphicsResult);
			skipUpdate = Boolean(addStandardSymbolsGraphicsResult.skipUpdate);
			break;
		}

		case 'update_symbols_graphics': {
			const updateSymbolsGraphicsResult = UpdateSymbolsGraphics(
				input.data as Required<SymbolsGraphics>,
				input.tab,
				input.action,
				product.symbols_graphics.data,
			);
			if (updateSymbolsGraphicsResult.error) return updateSymbolsGraphicsResult.error;

			const entity = input.data.entity?.toLowerCase();
			if(entity === 'barcodes') {
				const isDuplicateBarcode = await db.collection<Product>('products').findOne({
					_id: new ObjectId(input.id),
					'symbols_graphics.data': {
						$elemMatch: {
							_id: {$ne: new ObjectId(input.data.id)},
							entity: 'Barcodes',
							text: input.data.text,
							description: input.data.description,
						}
					}
				});
				if (isDuplicateBarcode) return ResponseWrapper.conflict('Barcode description already exists, please use a different barcode description.');
			} else if (entity !== 'other components') {
				const isDuplicategraphics = await db.collection<Product>('products').findOne({
					_id: new ObjectId(input.id),
					'symbols_graphics.data': {
						$elemMatch:{
							_id: {$ne: new ObjectId(input.data.id)},
							entity: input.data.entity,
							text: input.data.text,
						}
					}
				});
				if (isDuplicategraphics) return ResponseWrapper.conflict('Graphics description already exists, please use a different graphics description.');
			}

			({ updateQuery, updatedData } = updateSymbolsGraphicsResult);

			break;
		}

		case 'delete_symbols_graphics':
			const deleteSymbolsGraphicsResult = deleteSymbolsGraphics(input.data, input.tab, input.action);
			if (deleteSymbolsGraphicsResult.error) return deleteSymbolsGraphicsResult.error;

			({ updateQuery, updatedData } = deleteSymbolsGraphicsResult);

			break;

		case 'update_symbols_graphics_tab_completion':
			const updateSymbolsGraphicsTabCompletionResult = updateSymbolsGraphicsTabCompletion(input.data, input.tab, input.action);
			if (updateSymbolsGraphicsTabCompletionResult.error) return updateSymbolsGraphicsTabCompletionResult.error;

			({ updateQuery, updatedData } = updateSymbolsGraphicsTabCompletionResult);

			break;

		case 'add_product_data':
			const addProductDataResult = addProductData(input.data, input.tab, input.action);
			if (addProductDataResult.error) return addProductDataResult.error;

			({ updateQuery, updatedData } = addProductDataResult);

			break;

		case 'update_product_data':
			const updateProductDataResult = updateProductData(input.data, input.tab, input.action);
			if (updateProductDataResult.error) return updateProductDataResult.error;

			({ updateQuery, updatedData } = updateProductDataResult);

			break;

		case 'delete_product_data':
			const deleteProductDataResult = deleteProductData(input.tab, input.action);
			if (deleteProductDataResult.error) return deleteProductDataResult.error;

			({ updateQuery, updatedData } = deleteProductDataResult);

			break;

		case 'update_product_data_tab_completion':
			const updateProductDataTabCompletionResult = updateProductDataTabCompletion(input.data, input.tab, input.action);
			if (updateProductDataTabCompletionResult.error) return updateProductDataTabCompletionResult.error;

			({ updateQuery, updatedData } = updateProductDataTabCompletionResult);

			break;

		case 'add_operational_parameters':
			const addOperationalParametersResult = addOperationalParameters(input.data, input.tab, input.action);
			if (addOperationalParametersResult.error) return addOperationalParametersResult.error;

			({ updateQuery, updatedData } = addOperationalParametersResult);

			break;

		case 'update_operational_parameters':
			const updateOperationalParametersResult = updateOperationalParameters(input.data, input.tab, input.action);
			if (updateOperationalParametersResult.error) return updateOperationalParametersResult.error;

			({ updateQuery, updatedData } = updateOperationalParametersResult);

			break;

		case 'delete_operational_parameters':
			const deleteOperationalParametersResult = deleteOperationalParameters(input.tab, input.action);
			if (deleteOperationalParametersResult.error) return deleteOperationalParametersResult.error;

			({ updateQuery, updatedData } = deleteOperationalParametersResult);

			break;

		case 'update_operational_parameters_tab_completion':
			const updateOperationalParametersTabCompletionResult = updateOperationalParametersTabCompletion(input.data, input.tab, input.action);
			if (updateOperationalParametersTabCompletionResult.error) return updateOperationalParametersTabCompletionResult.error;

			({ updateQuery, updatedData } = updateOperationalParametersTabCompletionResult);

			break;

		case 'add_label_tags':
			const addLabelTagResult = addLabelTag(input.data, input.tab, input.action);
			if (addLabelTagResult.error) return addLabelTagResult.error;

			({ updateQuery, updatedData } = addLabelTagResult);

			break;

		case 'update_label_tags':
			const updateLabelTagResult = updateLabelTag(input.data, input.tab, input.action);
			if (updateLabelTagResult.error) return updateLabelTagResult.error;

			({ updateQuery, updatedData } = updateLabelTagResult);

			break;

		case 'delete_label_tags':
			const deleteLabelTagResult = deleteLabelTag(input.data, input.tab, input.action);
			if (deleteLabelTagResult.error) return deleteLabelTagResult.error;

			({ updateQuery, updatedData } = deleteLabelTagResult);

			break;

		case 'update_label_tags_tab_completion':
			const updateLabelTagsTabCompletionResult = updateLabelTagsTabCompletion(input.data, input.tab, input.action);
			if (updateLabelTagsTabCompletionResult.error) return updateLabelTagsTabCompletionResult.error;

			({ updateQuery, updatedData } = updateLabelTagsTabCompletionResult);

			break;

		case 'update_label_tag_tagged_image':
			const updateLabelTagTaggedImageResult = updateLabelTagTaggedImage(input.data, input.tab, input.action);
			if (updateLabelTagTaggedImageResult.error) return updateLabelTagTaggedImageResult.error;

			({ updateQuery, updatedData } = updateLabelTagTaggedImageResult);

			break;

		case 'update_label_tag_legend':
			const updateLabelTagLegendResult = updateLabelTagLegend(input.data, input.tab, input.action);
			if (updateLabelTagLegendResult.error) return updateLabelTagLegendResult.error;

			({ updateQuery, updatedData } = updateLabelTagLegendResult);

			break;

		default:
			return ResponseWrapper.badRequest('Invalid action');
		}

		if (skipUpdate) {
			return ResponseWrapper.success({
				message: 'Product updated successfully',
				action: input.action,
				tab: input.tab,
				data: updatedData,
			});
		}

		const options: { arrayFilters?: any[] } = {};
		if ('arrayFilters' in updateQuery) {
			options.arrayFilters = (updateQuery as any).arrayFilters;
			delete (updateQuery as any).arrayFilters; 
		}

		const updateResult = await db
			.collection<Product>('products')
			.updateOne({ _id: new ObjectId(input.id) }, updateQuery, options);
		if (updateResult.modifiedCount === 0) {
			return ResponseWrapper.notFound(
				'Product data not modified successfully, please check the data and try again.',
			);
		}

		const updatedProduct = await db.collection<Product>('products').findOne({ _id: new ObjectId(input.id) });
		const auditMeta = PRODUCT_DATA_ACTION_AUDIT_META[input.action];

		if (updatedProduct && auditMeta) {
			const payloadMeta: Record<string, unknown> = {
				productName: updatedProduct.product_name,
				tab: input.tab,
			};

			if (typeof input.data === 'object' && input.data) {
				if ('tab_completed' in (input.data as Record<string, unknown>)) {
					payloadMeta.tabCompleted = (input.data as Record<string, unknown>).tab_completed;
				}
			}

			await recordAuditEvent({
				workspaceId: updatedProduct.workspace_id.toString(),
				scope: { type: 'product', id: input.id },
				entity: { type: 'product', id: input.id },
				action: auditMeta.action,
				eventKey: auditMeta.eventKey,
				visibility: 'all',
				where: { module: 'products', tab: input.tab },
				auth: auth.payload,
				before: product as unknown as Record<string, unknown>,
				after: updatedProduct as unknown as Record<string, unknown>,
				changedPaths: auditMeta.changedPaths,
				meta: payloadMeta,
			});
		}

		return ResponseWrapper.success({
			message: 'Product updated successfully',
			action: input.action,
			tab: input.tab,
			data: updatedData,
		});
	} catch (error: unknown) {
		return ResponseWrapper.internalServerError(
			`Internal server error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};
