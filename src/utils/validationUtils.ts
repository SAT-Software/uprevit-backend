import { ObjectId } from 'mongodb';
import { ResponseWrapper } from './responseWrapper';
import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Validates multiple ObjectId fields
 * @param {Record<string, ObjectId | string>} fields - Object with field names as keys and values to validate
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateObjectIds(fields: Record<string, ObjectId | string>): APIGatewayProxyResult | null {
    for (const [fieldName, value] of Object.entries(fields)) {
        if (!ObjectId.isValid(value)) {
            return ResponseWrapper.badRequest(`Invalid ${fieldName} format. Must be a valid MongoDB ObjectId.`);
        }
    }
    return null;
}

/**
 * Validates multiple ObjectId arrays
 * @param {Record<string, ObjectId[] | string[]>} arrays - Object with field names as keys and arrays to validate
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateObjectIdArrays(arrays: Record<string, ObjectId[] | string[]>): APIGatewayProxyResult | null {
    for (const [fieldName, ids] of Object.entries(arrays)) {
        if (ids && ids.length > 0) {
            const invalidIds = ids.filter((id) => !ObjectId.isValid(id));
            if (invalidIds.length > 0) {
                return ResponseWrapper.badRequest(
                    `Invalid ${fieldName} format: ${invalidIds.join(', ')}. Must be valid MongoDB ObjectIds.`,
                );
            }
        }
    }
    return null;
}

/**
 * Validates both single ObjectIds and ObjectId arrays in one call
 * @param {Record<string, ObjectId | string>} singleIds - Object with field names as keys and single ObjectId values
 * @param {Record<string, ObjectId[] | string[]>} arrayIds - Object with field names as keys and ObjectId arrays
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateAllObjectIds(
    singleIds: Record<string, ObjectId | string> = {},
    arrayIds: Record<string, ObjectId[] | string[]> = {},
): APIGatewayProxyResult | null {
    // Validate single ObjectIds
    const singleValidation = validateObjectIds(singleIds);
    if (singleValidation) return singleValidation;

    // Validate ObjectId arrays
    const arrayValidation = validateObjectIdArrays(arrayIds);
    if (arrayValidation) return arrayValidation;

    return null;
}

/**
 * Validates missing fields
 * @param {Record<string, string>} fields - Object with field names as keys and values to validate
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateMissingFields(fields: Record<string, string>): APIGatewayProxyResult | null {
    for (const [fieldName, value] of Object.entries(fields)) {
        if (!value) {
            return ResponseWrapper.badRequest(`Missing required field(s): ${fieldName}`);
        }
    }

    return null;
}

/**
 * Validates enum values
 * @param {string[]} enumValues - Array of valid enum values
 * @param {string} value - Value to validate
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateEnum(enumValues: string[], value: string): APIGatewayProxyResult | null {
    if (!enumValues.includes(value)) {
        return ResponseWrapper.badRequest(`Invalid value. Must be one of: ${enumValues.join(', ')}`);
    }
    return null;
}

/**
 * Adds fields to an update object if they are present in the source data
 * @param {Record<string, any>} updateObject - The object to add fields to
 * @param {Record<string, any>} sourceData - The data to read from
 * @param {string[]} fields - A list of field names to process
 * @param {string} prefix - A prefix to add to the field names in the update object
 */
export function addFieldsToUpdate(
    updateObject: Record<string, any>,
    sourceData: Record<string, any>,
    fields: string[],
) {
    for (const field of fields) {
        if (sourceData[field] !== undefined) {
            updateObject[`${field}`] = sourceData[field];
        }
    }
}

/**
 * Validates the tab for a given action
 * @param {string} tab - The tab to validate
 * @param {string} expectedTab - The expected tab
 * @param {string} action - The action being performed
 * @return {APIGatewayProxyResult | null} ResponseWrapper error if invalid, null if all valid
 */
export function validateTab(tab: string, expectedTab: string, action: string): APIGatewayProxyResult | null {
    if (tab !== expectedTab) {
        return ResponseWrapper.badRequest(`Action ${action} must be used with tab ${expectedTab}`);
    }
    return null;
}

/**
 * Adds fields to an update object if they are present in the source data, with a dynamic prefix.
 * @param {Record<string, any>} updateObject - The object to add fields to
 * @param {Record<string, any>} sourceData - The data to read from
 * @param {string[]} fields - A list of field names to process
 * @param {string} prefix - A prefix to add to the field names in the update object
 */
export function addFieldsToUpdateWithPrefix(
    updateObject: Record<string, any>,
    sourceData: Record<string, any>,
    fields: string[],
    prefix: string,
) {
    for (const field of fields) {
        if (sourceData[field] !== undefined) {
            updateObject[`${prefix}.${field}`] = sourceData[field];
        }
    }
}
