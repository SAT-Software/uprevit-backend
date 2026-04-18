import { APIGatewayProxyResult } from 'aws-lambda';
import { validateTab, validateAllObjectIds } from '../../../utils/validationUtils';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { ObjectId } from 'mongodb';
import {
	UpdateProductInformationData,
	CustomFieldInput,
	DeleteCustomFieldInput,
	UpdateProductInformationCompletionData,
} from '../../../types/products/product-info';

type ExistingCustomField = {
	_id: ObjectId;
	parent_id?: string | null;
	label: string;
	value: string;
};

/**
 * Handles the update of product information fields.
 * @param {UpdateProductInformationData} inputData - The data object containing product information fields.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {Object} An object containing the update query, updated data, and any validation error.
 */
export function updateProductInformation(
	inputData: UpdateProductInformationData,
	tab: string,
	action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: UpdateProductInformationData;
    error: APIGatewayProxyResult | null;
} {
	try {
		const isValidTabUpdateProductInfo = validateTab(tab, 'product-information', action);
		if (isValidTabUpdateProductInfo)
			throw new Error(isValidTabUpdateProductInfo.body);
	
		const requiredFields = [
			'product_name',
			'product_plan_number',
			'product_description',
			'target_date',
			'actual_completion_date',
			'market_geography',
			'country_of_origin',
			'oem_contract_manufacturer',
			'commercial_clinical',
			'manufacturing_location',
		];
	
		const updateSet: Record<string, any> = {};

		for (const field of requiredFields) {
			if (field in inputData) {
				const value = (inputData as any)[field];

				// Update nested field
				updateSet[`product_information.data.${field}`] = value;

				// Update top-level field if applicable
				if (['product_name', 'product_plan_number', 'product_description', 'target_date', 'actual_completion_date'].includes(field)) {
					updateSet[field] = value;
				}
			}
		}
	
		const updateQuery = { $set: updateSet };
		const updatedData = inputData;
	
		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: {} as UpdateProductInformationData, error: ResponseWrapper.badRequest(error.message) };
		return { updateQuery: {}, updatedData: {} as UpdateProductInformationData, error: ResponseWrapper.internalServerError('Failed to update product information') };
	}
}

/**
 * Handles the addition of custom fields to product information.
 * @param {CustomFieldInput[]} inputData - An array of custom field data objects.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {Object} An object containing the update query, updated data, and any validation error.
 */
export function addCustomField(
	inputData: CustomFieldInput[],
	tab: string,
	action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { customFields: CustomFieldInput[] };
    error: APIGatewayProxyResult | null;
} {
	try {
		const isValidTabAddCustomField = validateTab(tab, 'product-information', action);
		if (isValidTabAddCustomField) throw new Error(isValidTabAddCustomField.body);
			
		if (!Array.isArray(inputData) || inputData.length === 0) throw new Error('Data for adding custom fields must be a non-empty array.');
	
		for (const item of inputData) {
			if (!item.label || !item.value) throw new Error('Each custom field must have both label and value.');
			
		}
	
		const newCustomFields = inputData.map((item) => ({
			_id: new ObjectId(),
			label: item.label,
			value: item.value,
		}));
	
		const updateQuery = { $push: { 'product_information.custom_fields': { $each: newCustomFields } } };
		const updatedData = { customFields: newCustomFields };
	
		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: { customFields: [] }, error: ResponseWrapper.badRequest(error.message) };

		return { updateQuery: {}, updatedData: { customFields: [] }, error: ResponseWrapper.internalServerError('Failed to add custom field') };
	}
}

/**
 * Handles the update of existing custom fields in product information.
 * @param {CustomFieldInput[]} inputData - An array of custom field data objects to update.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @param {ExistingCustomField[]} currentCustomFields - An array of existing custom fields to match against.
 * @return {Object} An object containing the update query, updated data, and any validation error.
 */
export function updateCustomField(
	inputData: CustomFieldInput[],
	tab: string,
	action: string,
	currentCustomFields: ExistingCustomField[] = [],
): {
    updateQuery: Record<string, unknown>;
    updatedData: { customFields: CustomFieldInput[] };
    error: APIGatewayProxyResult | null;
} {
	try {
		const isValidTabUpdateCustomField = validateTab(tab, 'product-information', action);
		if (isValidTabUpdateCustomField) throw new Error(isValidTabUpdateCustomField.body);
	
		if (!Array.isArray(inputData)) throw new Error('Data for updating custom fields must be an array.');

		const existingFieldsById = new Map(
			currentCustomFields.map((field) => [field._id.toString(), field]),
		);

		const normalizedCustomFields = inputData.map((field, index) => {
			const fieldId = field.id ?? field.field_id;
			const existingField = fieldId ? existingFieldsById.get(fieldId) : undefined;
			const fallbackField = !fieldId ? currentCustomFields[index] : undefined;
			const matchedField = existingField ?? fallbackField;

			if (!matchedField) {
				throw new Error('Each custom field update must reference an existing field id.');
			}

			return {
				_id: matchedField._id,
				parent_id: matchedField.parent_id ?? null,
				label: field.label ?? matchedField.label,
				value: field.value ?? matchedField.value,
			};
		});
	
		const updateQuery = { $set: { 'product_information.custom_fields': normalizedCustomFields } };
		const updatedData = {
			customFields: normalizedCustomFields.map((field) => ({
				id: field._id.toString(),
				parent_id: field.parent_id ?? null,
				label: field.label,
				value: field.value,
			})),
		};
	
		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: { customFields: [] }, error: ResponseWrapper.badRequest(error.message) };

		return { updateQuery: {}, updatedData: { customFields: [] }, error: ResponseWrapper.internalServerError('Failed to update custom field') };
	}
}

/**
 * Handles the deletion of a custom field from product information.
 * @param {DeleteCustomFieldInput} inputData - The data object containing the ID of the custom field to delete.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {Object} An object containing the update query, updated data, and any validation error.
 */
export function deleteCustomField(
	inputData: DeleteCustomFieldInput,
	tab: string,
	action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { id: string };
    error: APIGatewayProxyResult | null;
} {
	try {
		const isValidTabDeleteCustomField = validateTab(tab, 'product-information', action);
		if (isValidTabDeleteCustomField) throw new Error(isValidTabDeleteCustomField.body);
	
		const validatedFieldId = validateAllObjectIds({ id: inputData.id });
		if (validatedFieldId) return { updateQuery: {}, updatedData: { id: '' }, error: validatedFieldId };
	
		const updateQuery = { $pull: { 'product_information.custom_fields': { _id: new ObjectId(inputData.id) } } };
		const updatedData = { id: inputData.id };
	
		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: { id: '' }, error: ResponseWrapper.badRequest(error.message) };

		return { updateQuery: {}, updatedData: { id: '' }, error: ResponseWrapper.internalServerError('Failed to delete custom field') };
	}
}

/**
 * Handles the update of product information tab completion status.
 * @param {UpdateProductInformationCompletionData} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {Object} An object containing the update query, updated data, and any validation error.
 */
export function updateProductInfoTabCompletion(
	inputData: UpdateProductInformationCompletionData,
	tab: string,
	action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { tab_completed: boolean };
    error: APIGatewayProxyResult | null;
} {
	try {
		const isValidTabProductInfoCompletion = validateTab(tab, 'product-information', action);
		if (isValidTabProductInfoCompletion) throw new Error(isValidTabProductInfoCompletion.body);
	
		if (typeof inputData.tab_completed !== 'boolean') throw new Error('tab_completed must be a boolean value.');
	
		const updateQuery = { $set: { 'product_information.tab_completed': inputData.tab_completed } };
		const updatedData = { tab_completed: inputData.tab_completed };
	
		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: { tab_completed: false }, error: ResponseWrapper.badRequest(error.message) };
		
		return { updateQuery: {}, updatedData: { tab_completed: false }, error: ResponseWrapper.internalServerError('Failed to update product information tab completion') };
	}
}
