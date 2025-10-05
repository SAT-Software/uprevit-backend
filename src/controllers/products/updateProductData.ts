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
import { UpdateProductDataRequest } from '../../types/products/product-info';
import {
    addComplianceStandard,
    updateComplianceStandard,
    deleteComplianceStandard,
    updateComplianceTabCompletion
} from './productData/compliance-standard';

const validTabs = [
    'product-information',
    'compliance-information',
    'label-components',
    'symbols-graphics',
    'product-data',
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
                const deleteComplianceStandardResult = deleteComplianceStandard(input.data.id, input.tab, input.action);
                if (deleteComplianceStandardResult.error) return deleteComplianceStandardResult.error;

                ({ updateQuery, actionLog } = deleteComplianceStandardResult);
                updatedData = input.data;

                break;

            case 'update_compliance_tab_completion':
                const updateComplianceTabCompletionResult = updateComplianceTabCompletion(input.data, input.tab, input.action);
                if (updateComplianceTabCompletionResult.error) return updateComplianceTabCompletionResult.error;

                ({ updateQuery, updatedData, actionLog } = updateComplianceTabCompletionResult);

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
                'Custom field not found or already deleted, please check the provided custom field id.',
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
