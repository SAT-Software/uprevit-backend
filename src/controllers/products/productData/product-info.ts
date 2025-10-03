import { APIGatewayProxyResult } from 'aws-lambda';
import { addFieldsToUpdate, validateTab, validateAllObjectIds } from '../../../utils/validationUtils';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { ObjectId } from 'mongodb';
import {
    UpdateProductInformationData,
    AddCustomFieldData,
    UpdateCustomFieldInput,
    DeleteCustomFieldInput,
    UpdateProductInformationCompletionData,
} from '../../../types/products/product-info';

/**
 * Handles the update of product information fields.
 * @param {UpdateProductInformationData} inputData - The data object containing product information fields.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @returns {{ updateQuery: Record<string, unknown>, updatedData: UpdateProductInformationData, actionLog: string, error: APIGatewayProxyResult | null }} An object containing the update query, updated data, and any validation error.
 */
export function updateProductInformation(
    inputData: UpdateProductInformationData,
    tab: string,
    action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: UpdateProductInformationData;
    actionLog: string;
    error: APIGatewayProxyResult | null;
} {
    const isValidTabUpdateProductInfo = validateTab(tab, 'product-information', action);
    if (isValidTabUpdateProductInfo)
        return {
            updateQuery: {},
            updatedData: {} as UpdateProductInformationData,
            actionLog: '',
            error: isValidTabUpdateProductInfo,
        };

    const requiredFields = [
        'market_geography',
        'country_of_origin',
        'oem_contract_manufacturer',
        'commercial_clinical',
    ];

    const productInfoData: Partial<UpdateProductInformationData> = {};

    addFieldsToUpdate(productInfoData, inputData, requiredFields);

    const updateQuery = { $set: { 'product_information.data': productInfoData } };
    const updatedData = inputData;
    const actionLog = 'UPDATE';

    return { updateQuery, updatedData, actionLog, error: null };
}

/**
 * Handles the addition of custom fields to product information.
 * @param {AddCustomFieldData[]} inputData - An array of custom field data objects.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @returns {{ updateQuery: Record<string, unknown>, updatedData: { customFields: AddCustomFieldData[] }, actionLog: string, error: APIGatewayProxyResult | null }} An object containing the update query, updated data, and any validation error.
 */
export function addCustomField(
    inputData: AddCustomFieldData[],
    tab: string,
    action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { customFields: AddCustomFieldData[] };
    actionLog: string;
    error: APIGatewayProxyResult | null;
} {
    const isValidTabAddCustomField = validateTab(tab, 'product-information', action);
    if (isValidTabAddCustomField)
        return { updateQuery: {}, updatedData: { customFields: [] }, actionLog: '', error: isValidTabAddCustomField };

    if (!Array.isArray(inputData) || inputData.length === 0)
        return {
            updateQuery: {},
            updatedData: { customFields: [] },
            actionLog: '',
            error: ResponseWrapper.badRequest('Data must be an array of custom fields'),
        };

    for (const item of inputData) {
        if (!item.label || !item.value) {
            return {
                updateQuery: {},
                updatedData: { customFields: [] },
                actionLog: '',
                error: ResponseWrapper.badRequest('Each custom field must have label and value'),
            };
        }
    }

    const newCustomFields = inputData.map((item) => ({
        _id: new ObjectId(),
        label: item.label,
        value: item.value,
    }));

    const updateQuery = { $push: { 'product_information.custom_fields': { $each: newCustomFields } } };
    const updatedData = { customFields: newCustomFields };
    const actionLog = 'CREATE';

    return { updateQuery, updatedData, actionLog, error: null };
}

/**
 * Handles the update of existing custom fields in product information.
 * @param {UpdateCustomFieldInput[]} inputData - An array of custom field data objects to update.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @returns {{ updateQuery: Record<string, unknown>, updatedData: { customFields: UpdateCustomFieldInput[] }, actionLog: string, error: APIGatewayProxyResult | null }} An object containing the update query, updated data, and any validation error.
 */
export function updateCustomField(
    inputData: UpdateCustomFieldInput[],
    tab: string,
    action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { customFields: UpdateCustomFieldInput[] };
    actionLog: string;
    error: APIGatewayProxyResult | null;
} {
    const isValidTabUpdateCustomField = validateTab(tab, 'product-information', action);
    if (isValidTabUpdateCustomField)
        return {
            updateQuery: {},
            updatedData: { customFields: [] },
            actionLog: '',
            error: isValidTabUpdateCustomField,
        };

    if (!Array.isArray(inputData)) {
        return {
            updateQuery: {},
            updatedData: { customFields: [] },
            actionLog: '',
            error: ResponseWrapper.badRequest('Data for updating custom fields must be an array.'),
        };
    }

    const validatedCustomFields = inputData.map((field) => ({
        ...field,
        _id: field.id ? new ObjectId(field.id) : new ObjectId(),
    }));

    const updateQuery = { $set: { 'product_information.custom_fields': validatedCustomFields } };
    const updatedData = { customFields: inputData };
    const actionLog = 'UPDATE';

    return { updateQuery, updatedData, actionLog, error: null };
}

/**
 * Handles the deletion of a custom field from product information.
 * @param {DeleteCustomFieldInput} inputData - The data object containing the ID of the custom field to delete.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @returns {{ updateQuery: Record<string, unknown>, updatedData: { id: string }, actionLog: string, error: APIGatewayProxyResult | null }} An object containing the update query, updated data, and any validation error.
 */
export function deleteCustomField(
    inputData: DeleteCustomFieldInput,
    tab: string,
    action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { id: string };
    actionLog: string;
    error: APIGatewayProxyResult | null;
} {
    const isValidTabDeleteCustomField = validateTab(tab, 'product-information', action);
    if (isValidTabDeleteCustomField)
        return { updateQuery: {}, updatedData: { id: '' }, actionLog: '', error: isValidTabDeleteCustomField };

    const validatedFieldId = validateAllObjectIds({ id: inputData.id });
    if (validatedFieldId) return { updateQuery: {}, updatedData: { id: '' }, actionLog: '', error: validatedFieldId };

    const updateQuery = { $pull: { 'product_information.custom_fields': { _id: new ObjectId(inputData.id) } } };
    const updatedData = { id: inputData.id };
    const actionLog = 'DELETE';

    return { updateQuery, updatedData, actionLog, error: null };
}

/**
 * Handles the update of product information tab completion status.
 * @param {UpdateProductInformationCompletionData} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @returns {{ updateQuery: Record<string, unknown>, updatedData: { tab_completed: boolean }, actionLog: string, error: APIGatewayProxyResult | null }} An object containing the update query, updated data, and any validation error.
 */
export function updateProductInfoTabCompletion(
    inputData: UpdateProductInformationCompletionData,
    tab: string,
    action: string,
): {
    updateQuery: Record<string, unknown>;
    updatedData: { tab_completed: boolean };
    actionLog: string;
    error: APIGatewayProxyResult | null;
} {
    const isValidTabProductInfoCompletion = validateTab(tab, 'product-information', action);
    if (isValidTabProductInfoCompletion)
        return {
            updateQuery: {},
            updatedData: { tab_completed: inputData.tab_completed },
            actionLog: '',
            error: isValidTabProductInfoCompletion,
        };

    if (typeof inputData.tab_completed !== 'boolean') {
        return {
            updateQuery: {},
            updatedData: { tab_completed: inputData.tab_completed },
            actionLog: '',
            error: ResponseWrapper.badRequest('tab_completed must be a boolean value'),
        };
    }

    const updateQuery = { $set: { 'product_information.tab_completed': inputData.tab_completed } };
    const updatedData = { tab_completed: inputData.tab_completed };
    const actionLog = 'UPDATE';

    return { updateQuery, updatedData, actionLog, error: null };
}
