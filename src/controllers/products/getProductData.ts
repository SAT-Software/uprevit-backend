import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { ExcelData, LabelTags, Product, SymbolsGraphics, ProductInformation, ComplianceInformation, LabelComponents } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { verifyJWT } from '../../utils/authUtils';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        const token = authHeader.split(' ')[1];

        // Check if the user is valid - both users and admins can get product data
        const { isValid, payload } = await verifyJWT(token);
        if (!isValid) {
            return ResponseWrapper.unauthorized('Unauthorized');
        }

        // Extract query parameters
        const productId = event.queryStringParameters?.id;
        const tab = event.queryStringParameters?.tab;

        if (!productId) {
            return ResponseWrapper.badRequest("Product id - 'id' is required in query parameters");
        }

        if (!tab) {
            return ResponseWrapper.badRequest("Product data tab - 'tab' is required in query parameters");
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(productId)) {
            return ResponseWrapper.badRequest('Invalid product id format. Must be a valid MongoDB ObjectId.');
        }

        // Validate tab parameter
        const validTabs = [
            'product-information',
            'compliance-information',
            'label-components',
            'symbols-graphics',
            'product-data',
            'operational-parameters',
            'label-tags',
        ];

        if (!validTabs.includes(tab)) {
            return ResponseWrapper.badRequest(`Invalid tab. Must be one of: ${validTabs.join(', ')}`);
        }

        const db = await getDb();
        const productObjectId = new ObjectId(productId);

        // Find the product
        const product = await db.collection<Product>('products').findOne({
            _id: productObjectId,
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found');
        }

        // Extract data based on tab
        let tabData: ProductInformation | ComplianceInformation | LabelComponents | SymbolsGraphics | ExcelData | LabelTags;

        switch (tab) {
            case 'product-information':
                tabData = {
                    data: { ...product.product_information.data },
                    tab_completed: product.product_information.tab_completed,
                };
                break;

            case 'compliance-information':
                tabData = {
                    data: product.compliance_information.data,
                    tab_completed: product.compliance_information.tab_completed,
                };
                break;

            case 'label-components':
                tabData = {
                    data: product.label_components.data,
                    tab_completed: product.label_components.tab_completed,
                };
                break;

            case 'symbols-graphics':
                tabData = {
                    data: product.symbols_graphics.data,
                    tab_completed: product.symbols_graphics.tab_completed,
                };
                break;

            case 'product-data':
                tabData = {
                    data: {
                        _id: product.product_data.data._id,
                        workbook_data: product.product_data.data.workbook_data,
                    },
                    tab_completed: product.product_data.tab_completed,
                };
                break;

            case 'operational-parameters':
                tabData = {
                    data: {
                        _id: product.operational_parameters.data._id,
                        workbook_data: product.operational_parameters.data.workbook_data,
                    },
                    tab_completed: product.operational_parameters.tab_completed,
                };
                break;

            case 'label-tags':
                tabData = {
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
                data: tabData,
            },
        });
    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};
