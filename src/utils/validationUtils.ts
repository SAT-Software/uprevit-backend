
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from './responseWrapper';
import { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Validates multiple ObjectId fields
 * @param fields - Object with field names as keys and values to validate
 * @returns ResponseWrapper error if invalid, null if all valid
 */
export function validateObjectIds(fields: Record<string, string>): APIGatewayProxyResult | null {
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!ObjectId.isValid(value)) {
      return ResponseWrapper.badRequest(`Invalid ${fieldName} format. Must be a valid MongoDB ObjectId.`);
    }
  }
  return null;
}

/**
 * Validates multiple ObjectId arrays
 * @param arrays - Object with field names as keys and arrays to validate
 * @returns ResponseWrapper error if invalid, null if all valid
 */
export function validateObjectIdArrays(arrays: Record<string, string[] | undefined>): APIGatewayProxyResult | null {
  for (const [fieldName, ids] of Object.entries(arrays)) {
    if (ids && ids.length > 0) {
      const invalidIds = ids.filter(id => !ObjectId.isValid(id));
      if (invalidIds.length > 0) {
        return ResponseWrapper.badRequest(
          `Invalid ${fieldName} format: ${invalidIds.join(', ')}. Must be valid MongoDB ObjectIds.`
        );
      }
    }
  }
  return null;
}

/**
 * Validates both single ObjectIds and ObjectId arrays in one call
 * @param singleIds - Object with field names as keys and single ObjectId values
 * @param arrayIds - Object with field names as keys and ObjectId arrays
 * @returns ResponseWrapper error if invalid, null if all valid
 */
export function validateAllObjectIds(
  singleIds: Record<string, string> = {},
  arrayIds: Record<string, string[] | undefined> = {}
): APIGatewayProxyResult | null {
  // Validate single ObjectIds
  const singleValidation = validateObjectIds(singleIds);
  if (singleValidation) return singleValidation;
  
  // Validate ObjectId arrays
  const arrayValidation = validateObjectIdArrays(arrayIds);
  if (arrayValidation) return arrayValidation;
  
  return null;
}
