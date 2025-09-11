import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Extract query parameters
        const id = event.queryStringParameters?.id;
        const tab = event.queryStringParameters?.tab;

        // Validate required parameters
        if (!id) {
            return ResponseWrapper.badRequest('Product ID is required');
        }

        if (!tab) {
            return ResponseWrapper.badRequest('Tab parameter is required');
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(id)) {
            return ResponseWrapper.badRequest('Invalid product ID format. Must be a valid MongoDB ObjectId.');
        }

        // Validate tab parameter
        const validTabs = ['product-information', 'compliance-information', 'label-components', 'symbols-graphics'];
        if (!validTabs.includes(tab)) {
            return ResponseWrapper.badRequest(`Invalid tab parameter. Must be one of: ${validTabs.join(', ')}`);
        }

        const db = await getDb();

        // Find the product
        const product = await db.collection<Product>('products').findOne({
            _id: new ObjectId(id)
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found');
        }

        let responseData: any = {};

        switch (tab) {
            case 'product-information':
                responseData = {
                    tab: 'product-information',
                    data: {
                        market_geography: product.product_information.market_geography,
                        country_of_origin: product.product_information.country_of_origin,
                        oem_contract_manufacturer: product.product_information.oem_contract_manufacturer,
                        commercial_clinical: product.product_information.commercial_clinical,
                        custom_fields: (product.product_information.custom_fields || []).map(field => ({
                            _id: field._id,
                            label: field.field_name,
                            value: field.field_value
                        })),
                        tab_completed: product.product_information.tab_completed
                    }
                };
                break;

            case 'compliance-information':
                responseData = {
                    tab: 'compliance-information',
                    data: {
                        data: product.compliance_information.data.map(item => ({
                            _id: item._id,
                            standard: item.compliance_type,
                            standard_description: item.notes || ''
                        })),
                        tab_completed: product.compliance_information.tab_completed
                    }
                };
                break;

            case 'label-components':
                responseData = {
                    tab: 'label-components',
                    data: {
                        data: product.label_components.data.map(item => ({
                            _id: item._id,
                            component_image: item.component_image || '',
                            component_name: item.component_name,
                            component_number: item.component_type || '',
                            specification_details: [item.dimensions, item.material, item.color].filter(Boolean).join(' ')
                        })),
                        tab_completed: product.label_components.tab_completed
                    }
                };
                break;

            case 'symbols-graphics':
                responseData = {
                    tab: 'symbols-graphics',
                    data: product.symbols_graphics.map(item => ({
                        image: item.image,
                        text: item.text,
                        description: item.description,
                        text_present: item.text_present,
                        label_presence: item.label_presence,
                        entity: item.entity
                    }))
                };
                break;
        }

        return ResponseWrapper.success(responseData);

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};