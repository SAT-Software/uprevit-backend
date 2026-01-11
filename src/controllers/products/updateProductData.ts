import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateAllObjectIds, validateMissingFields } from '../../utils/validationUtils';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { ObjectId } from 'mongodb';
import { AuditLog } from '../../models/auditLog';
import { authenticateRequest } from '../../utils/authUtils';
import { updateAuditLog } from '../../utils/auditLog';
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
import { AddSymbolsGraphics, deleteSymbolsGraphics, UpdateSymbolsGraphics, updateSymbolsGraphicsTabCompletion } from './productData/symbols-graphics';
import { addProductData, deleteProductData, updateProductData, updateProductDataTabCompletion } from './productData/product-data';
import { addOperationalParameters, deleteOperationalParameters, updateOperationalParameters, updateOperationalParametersTabCompletion } from './productData/operational-parameters';
import { addLabelTag, deleteLabelTag, updateLabelTag, updateLabelTagsTabCompletion, updateLabelTagTaggedImage } from './productData/label-tags';


const validTabs = [
	'product-information',
	'compliance-information',
	'label-components',
	'symbols-graphics',
	'product-specifications',
	'operational-parameters',
	'label-tags',
];


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
		let actionLog = '';

		switch (input.action) {
		case 'update_product_information':
			const result = updateProductInformation(input.data, input.tab, input.action);
			if (result.error) return result.error;

			({ updateQuery, updatedData, actionLog } = result);

			break;

		case 'add_custom_field':
			const addCustomFieldResult = addCustomField(input.data, input.tab, input.action);
			if (addCustomFieldResult.error) return addCustomFieldResult.error;

			({ updateQuery, updatedData, actionLog } = addCustomFieldResult);

			break;

		case 'update_custom_field':
			const updateCustomFieldResult = updateCustomField(input.data, input.tab, input.action);
			if (updateCustomFieldResult.error) return updateCustomFieldResult.error;

			({ updateQuery, updatedData, actionLog } = updateCustomFieldResult);

			break;

		case 'delete_custom_field':
			const deleteCustomFieldResult = deleteCustomField(input.data, input.tab, input.action);
			if (deleteCustomFieldResult.error) return deleteCustomFieldResult.error;

			({ updateQuery, updatedData, actionLog } = deleteCustomFieldResult);

			break;

		case 'update_product_information_completion':
			const updateTabCompletionResult = updateProductInfoTabCompletion(input.data, input.tab, input.action);
			if (updateTabCompletionResult.error) return updateTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateTabCompletionResult);

			break;

		case 'add_compliance_standard':
			const addComplianceStandardResult = addComplianceStandard(input.data, input.tab, input.action);
			if (addComplianceStandardResult.error) return addComplianceStandardResult.error;

			({ updateQuery, updatedData, actionLog } = addComplianceStandardResult);

			break;

		case 'update_compliance_standard':
			const updateComplianceStandardResult = updateComplianceStandard(input.data, input.tab, input.action);
			if (updateComplianceStandardResult.error) return updateComplianceStandardResult.error;

			({ updateQuery, updatedData, actionLog } = updateComplianceStandardResult);

			break;

		case 'delete_compliance_standard':
			const deleteComplianceStandardResult = deleteComplianceStandard(input.data, input.tab, input.action);
			if (deleteComplianceStandardResult.error) return deleteComplianceStandardResult.error;

			({ updateQuery, actionLog } = deleteComplianceStandardResult);
			updatedData = input.data;

			break;

		case 'update_compliance_tab_completion':
			const updateComplianceTabCompletionResult = updateComplianceTabCompletion(input.data, input.tab, input.action);
			if (updateComplianceTabCompletionResult.error) return updateComplianceTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateComplianceTabCompletionResult);

			break;

		case 'add_label_component':
			const addLabelComponentResult = addLabelComponent(input.data, input.tab, input.action);
			if (addLabelComponentResult.error) return addLabelComponentResult.error;

			({ updateQuery, updatedData, actionLog } = addLabelComponentResult);

			break;

		case 'update_label_component':
			const updateLabelComponentResult = updateLabelComponent(input.data, input.tab, input.action);
			if (updateLabelComponentResult.error) return updateLabelComponentResult.error;

			({ updateQuery, updatedData, actionLog } = updateLabelComponentResult);

			break;

		case 'delete_label_component':
			const deleteLabelComponentResult = deleteLabelComponent(input.data, input.tab, input.action);
			if (deleteLabelComponentResult.error) return deleteLabelComponentResult.error;

			({ updateQuery, updatedData, actionLog } = deleteLabelComponentResult);

			break;

		case 'update_label_component_tab_completion':
			const updateLabelComponentTabCompletionResult = updateLabelComponentTabCompletion(input.data, input.tab, input.action);
			if (updateLabelComponentTabCompletionResult.error) return updateLabelComponentTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateLabelComponentTabCompletionResult);

			break;
		case 'add_symbols_graphics':
			const addSymbolsGraphicsResult = AddSymbolsGraphics(input.data, input.tab, input.action);
			if (addSymbolsGraphicsResult.error) return addSymbolsGraphicsResult.error;

			({ updateQuery, updatedData, actionLog } = addSymbolsGraphicsResult);

			break;

		case 'update_symbols_graphics':
			const updateSymbolsGraphicsResult = UpdateSymbolsGraphics(input.data, input.tab, input.action);
			if (updateSymbolsGraphicsResult.error) return updateSymbolsGraphicsResult.error;

			({ updateQuery, updatedData, actionLog } = updateSymbolsGraphicsResult);

			break;

		case 'delete_symbols_graphics':
			const deleteSymbolsGraphicsResult = deleteSymbolsGraphics(input.data, input.tab, input.action);
			if (deleteSymbolsGraphicsResult.error) return deleteSymbolsGraphicsResult.error;

			({ updateQuery, updatedData, actionLog } = deleteSymbolsGraphicsResult);

			break;

		case 'update_symbols_graphics_tab_completion':
			const updateSymbolsGraphicsTabCompletionResult = updateSymbolsGraphicsTabCompletion(input.data, input.tab, input.action);
			if (updateSymbolsGraphicsTabCompletionResult.error) return updateSymbolsGraphicsTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateSymbolsGraphicsTabCompletionResult);

			break;

		case 'add_product_data':
			const addProductDataResult = addProductData(input.data, input.tab, input.action);
			if (addProductDataResult.error) return addProductDataResult.error;

			({ updateQuery, updatedData, actionLog } = addProductDataResult);

			break;

		case 'update_product_data':
			const updateProductDataResult = updateProductData(input.data, input.tab, input.action);
			if (updateProductDataResult.error) return updateProductDataResult.error;

			({ updateQuery, updatedData, actionLog } = updateProductDataResult);

			break;

		case 'delete_product_data':
			const deleteProductDataResult = deleteProductData(input.tab, input.action);
			if (deleteProductDataResult.error) return deleteProductDataResult.error;

			({ updateQuery, updatedData, actionLog } = deleteProductDataResult);

			break;

		case 'update_product_data_tab_completion':
			const updateProductDataTabCompletionResult = updateProductDataTabCompletion(input.data, input.tab, input.action);
			if (updateProductDataTabCompletionResult.error) return updateProductDataTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateProductDataTabCompletionResult);

			break;

		case 'add_operational_parameters':
			const addOperationalParametersResult = addOperationalParameters(input.data, input.tab, input.action);
			if (addOperationalParametersResult.error) return addOperationalParametersResult.error;

			({ updateQuery, updatedData, actionLog } = addOperationalParametersResult);

			break;

		case 'update_operational_parameters':
			const updateOperationalParametersResult = updateOperationalParameters(input.data, input.tab, input.action);
			if (updateOperationalParametersResult.error) return updateOperationalParametersResult.error;

			({ updateQuery, updatedData, actionLog } = updateOperationalParametersResult);

			break;

		case 'delete_operational_parameters':
			const deleteOperationalParametersResult = deleteOperationalParameters(input.tab, input.action);
			if (deleteOperationalParametersResult.error) return deleteOperationalParametersResult.error;

			({ updateQuery, updatedData, actionLog } = deleteOperationalParametersResult);

			break;

		case 'update_operational_parameters_tab_completion':
			const updateOperationalParametersTabCompletionResult = updateOperationalParametersTabCompletion(input.data, input.tab, input.action);
			if (updateOperationalParametersTabCompletionResult.error) return updateOperationalParametersTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateOperationalParametersTabCompletionResult);

			break;

		case 'add_label_tags':
			const addLabelTagResult = addLabelTag(input.data, input.tab, input.action);
			if (addLabelTagResult.error) return addLabelTagResult.error;

			({ updateQuery, updatedData, actionLog } = addLabelTagResult);

			break;

		case 'update_label_tags':
			const updateLabelTagResult = updateLabelTag(input.data, input.tab, input.action);
			if (updateLabelTagResult.error) return updateLabelTagResult.error;

			({ updateQuery, updatedData, actionLog } = updateLabelTagResult);

			break;

		case 'delete_label_tags':
			const deleteLabelTagResult = deleteLabelTag(input.data, input.tab, input.action);
			if (deleteLabelTagResult.error) return deleteLabelTagResult.error;

			({ updateQuery, updatedData, actionLog } = deleteLabelTagResult);

			break;

		case 'update_label_tags_tab_completion':
			const updateLabelTagsTabCompletionResult = updateLabelTagsTabCompletion(input.data, input.tab, input.action);
			if (updateLabelTagsTabCompletionResult.error) return updateLabelTagsTabCompletionResult.error;

			({ updateQuery, updatedData, actionLog } = updateLabelTagsTabCompletionResult);

			break;

		case 'update_label_tag_tagged_image':
			const updateLabelTagTaggedImageResult = updateLabelTagTaggedImage(input.data, input.tab, input.action);
			if (updateLabelTagTaggedImageResult.error) return updateLabelTagTaggedImageResult.error;

			({ updateQuery, updatedData, actionLog } = updateLabelTagTaggedImageResult);

			break;

		default:
			return ResponseWrapper.badRequest('Invalid action');
		}

		const auditLog: AuditLog = {
			entity: 'Product',
			entityId: input.id,
			action: actionLog as AuditLog['action'],
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		};

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

		await updateAuditLog(auditLog);

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