import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Product } from '../../models/product';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';

interface UpdateProductDataRequest {
    id: string;
    action: string;
    tab: string;
    data: any;
}

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        const input: UpdateProductDataRequest = JSON.parse(event.body);

        // Validate required fields
        if (!input.id || !input.action || !input.tab || input.data === undefined) {
            return ResponseWrapper.badRequest('Missing required fields: id, action, tab, and data are required');
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(input.id)) {
            return ResponseWrapper.badRequest('Invalid product ID format. Must be a valid MongoDB ObjectId.');
        }

        // Validate tab parameter
        const validTabs = ['product-information', 'compliance-information', 'label-components', 'symbols-graphics', 'product-data'];
        if (!validTabs.includes(input.tab)) {
            return ResponseWrapper.badRequest(`Invalid tab parameter. Must be one of: ${validTabs.join(', ')}`);
        }

        const db = await getDb();

        // Find the product
        const product = await db.collection<Product>('products').findOne({
            _id: new ObjectId(input.id)
        });

        if (!product) {
            return ResponseWrapper.notFound('Product not found');
        }

        let updateQuery: any = {};
        let updatedData: any = {};

        switch (input.action) {
            case 'update_product_information':
                if (input.tab !== 'product-information') {
                    return ResponseWrapper.badRequest('Action update_product_information must be used with tab product-information');
                }
                
                const productInfoUpdates: any = {};
                if (input.data.market_geography !== undefined) productInfoUpdates['product_information.market_geography'] = input.data.market_geography;
                if (input.data.country_of_origin !== undefined) productInfoUpdates['product_information.country_of_origin'] = input.data.country_of_origin;
                if (input.data.oem_contract_manufacturer !== undefined) productInfoUpdates['product_information.oem_contract_manufacturer'] = input.data.oem_contract_manufacturer;
                if (input.data.commercial_clinical !== undefined) productInfoUpdates['product_information.commercial_clinical'] = input.data.commercial_clinical;
                
                updateQuery = { $set: productInfoUpdates };
                updatedData = input.data;
                break;

            case 'add_custom_field':
                if (input.tab !== 'product-information') {
                    return ResponseWrapper.badRequest('Action add_custom_field must be used with tab product-information');
                }

                if (!Array.isArray(input.data) || input.data.length === 0) {
                    return ResponseWrapper.badRequest('Data must be an array of custom fields');
                }

                const newCustomFields = input.data.map((item: any) => {
                    if (!item.label || !item.value) {
                        throw new Error('Each custom field must have label and value');
                    }
                    return {
                        _id: new ObjectId(),
                        field_name: item.label,
                        field_value: item.value
                    };
                });

                updateQuery = { $push: { 'product_information.custom_fields': { $each: newCustomFields } } };
                updatedData = newCustomFields.map(field => ({
                    _id: field._id,
                    label: field.field_name,
                    value: field.field_value
                }));
                break;

            case 'update_custom_field':
                if (input.tab !== 'product-information') {
                    return ResponseWrapper.badRequest('Action update_custom_field must be used with tab product-information');
                }
                
                if (!input.data.field_id || !input.data.label || !input.data.value) {
                    return ResponseWrapper.badRequest('Missing required fields: field_id, label and value are required');
                }
                
                if (!ObjectId.isValid(input.data.field_id)) {
                    return ResponseWrapper.badRequest('Invalid field_id format. Must be a valid MongoDB ObjectId.');
                }
                
                updateQuery = {
                    $set: {
                        'product_information.custom_fields.$[elem].field_name': input.data.label,
                        'product_information.custom_fields.$[elem].field_value': input.data.value
                    }
                };
                
                const arrayFilters = [{ 'elem._id': new ObjectId(input.data.field_id) }];
                updatedData = { field_id: input.data.field_id, label: input.data.label, value: input.data.value };
                
                await db.collection<Product>('products').updateOne(
                    { _id: new ObjectId(input.id) },
                    updateQuery,
                    { arrayFilters }
                );
                break;

            case 'delete_custom_field':
                if (input.tab !== 'product-information') {
                    return ResponseWrapper.badRequest('Action delete_custom_field must be used with tab product-information');
                }
                
                if (!input.data.field_id) {
                    return ResponseWrapper.badRequest('Missing required field: field_id is required');
                }
                
                if (!ObjectId.isValid(input.data.field_id)) {
                    return ResponseWrapper.badRequest('Invalid field_id format. Must be a valid MongoDB ObjectId.');
                }
                
                updateQuery = { $pull: { 'product_information.custom_fields': { _id: new ObjectId(input.data.field_id) } } };
                updatedData = { field_id: input.data.field_id };
                break;

            case 'add_compliance_standard':
                if (input.tab !== 'compliance-information') {
                    return ResponseWrapper.badRequest('Action add_compliance_standard must be used with tab compliance-information');
                }
                
                if (!Array.isArray(input.data) || input.data.length === 0) {
                    return ResponseWrapper.badRequest('Data must be an array of compliance standards');
                }
                
                const newComplianceItems = input.data.map((item: any) => {
                    if (!item.standard || !item.standard_description) {
                        throw new Error('Each compliance standard must have standard and standard_description');
                    }
                    return {
                        _id: new ObjectId(),
                        compliance_type: item.standard,
                        status: 'active',
                        reference_number: '',
                        notes: item.standard_description
                    };
                });
                
                updateQuery = { $push: { 'compliance_information.data': { $each: newComplianceItems } } };
                updatedData = newComplianceItems.map(item => ({
                    _id: item._id,
                    standard: item.compliance_type,
                    standard_description: item.notes
                }));
                break;

            case 'update_compliance_standard':
                if (input.tab !== 'compliance-information') {
                    return ResponseWrapper.badRequest('Action update_compliance_standard must be used with tab compliance-information');
                }

                if (!input.data.standard_id || !input.data.standard || !input.data.standard_description) {
                    return ResponseWrapper.badRequest('Missing required fields: standard_id, standard, and standard_description are required');
                }

                if (!ObjectId.isValid(input.data.standard_id)) {
                    return ResponseWrapper.badRequest('Invalid standard_id format. Must be a valid MongoDB ObjectId.');
                }

                // Check if the compliance standard exists first
                const existingComplianceProduct = await db.collection<Product>('products').findOne({
                    _id: new ObjectId(input.id),
                    'compliance_information.data._id': new ObjectId(input.data.standard_id)
                });

                if (!existingComplianceProduct) {
                    return ResponseWrapper.notFound('Compliance standard not found');
                }

                const complianceUpdates: any = {
                    'compliance_information.data.$[elem].compliance_type': input.data.standard,
                    'compliance_information.data.$[elem].notes': input.data.standard_description
                };

                updateQuery = { $set: complianceUpdates };
                const complianceArrayFilters = [{ 'elem._id': new ObjectId(input.data.standard_id) }];
                updatedData = {
                    standard_id: input.data.standard_id,
                    standard: input.data.standard,
                    standard_description: input.data.standard_description
                };

                const complianceUpdateResult = await db.collection<Product>('products').updateOne(
                    { _id: new ObjectId(input.id) },
                    updateQuery,
                    { arrayFilters: complianceArrayFilters }
                );

                if (complianceUpdateResult.matchedCount === 0) {
                    return ResponseWrapper.notFound('Product not found');
                }

                if (complianceUpdateResult.modifiedCount === 0) {
                    return ResponseWrapper.badRequest('Compliance standard could not be updated. Standard ID may not exist.');
                }
                break;

            case 'delete_compliance_standard':
                if (input.tab !== 'compliance-information') {
                    return ResponseWrapper.badRequest('Action delete_compliance_standard must be used with tab compliance-information');
                }
                
                if (!input.data.standard_id) {
                    return ResponseWrapper.badRequest('Missing required field: standard_id is required');
                }
                
                if (!ObjectId.isValid(input.data.standard_id)) {
                    return ResponseWrapper.badRequest('Invalid standard_id format. Must be a valid MongoDB ObjectId.');
                }
                
                updateQuery = { $pull: { 'compliance_information.data': { _id: new ObjectId(input.data.standard_id) } } };
                updatedData = { standard_id: input.data.standard_id };
                break;

            case 'update_compliance_tab_completion':
                if (input.tab !== 'compliance-information') {
                    return ResponseWrapper.badRequest('Action update_compliance_tab_completion must be used with tab compliance-information');
                }
                
                if (typeof input.data.tab_completed !== 'boolean') {
                    return ResponseWrapper.badRequest('tab_completed must be a boolean value');
                }
                
                updateQuery = { $set: { 'compliance_information.tab_completed': input.data.tab_completed } };
                updatedData = { tab_completed: input.data.tab_completed };
                break;

            case 'add_label_component':
                if (input.tab !== 'label-components') {
                    return ResponseWrapper.badRequest('Action add_label_component must be used with tab label-components');
                }
                
                if (!input.data.component_name) {
                    return ResponseWrapper.badRequest('Missing required field: component_name is required');
                }
                
                const newLabelComponent = {
                    _id: new ObjectId(),
                    component_name: input.data.component_name,
                    component_type: input.data.component_number || '',
                    component_image: input.data.component_image || '',
                    dimensions: input.data.specification_details || ''
                };
                
                updateQuery = { $push: { 'label_components.data': newLabelComponent } };
                updatedData = {
                    _id: newLabelComponent._id,
                    component_image: input.data.component_image || '',
                    component_name: newLabelComponent.component_name,
                    component_number: newLabelComponent.component_type,
                    specification_details: newLabelComponent.dimensions
                };
                break;

            case 'update_label_component':
                if (input.tab !== 'label-components') {
                    return ResponseWrapper.badRequest('Action update_label_component must be used with tab label-components');
                }

                if (!input.data.component_id) {
                    return ResponseWrapper.badRequest('Missing required field: component_id is required');
                }

                if (!ObjectId.isValid(input.data.component_id)) {
                    return ResponseWrapper.badRequest('Invalid component_id format. Must be a valid MongoDB ObjectId.');
                }

                // Check if the component exists first
                const existingProduct = await db.collection<Product>('products').findOne({
                    _id: new ObjectId(input.id),
                    'label_components.data._id': new ObjectId(input.data.component_id)
                });

                if (!existingProduct) {
                    return ResponseWrapper.notFound('Label component not found');
                }

                const componentUpdates: any = {};
                if (input.data.component_name !== undefined) componentUpdates['label_components.data.$[elem].component_name'] = input.data.component_name;
                if (input.data.component_number !== undefined) componentUpdates['label_components.data.$[elem].component_type'] = input.data.component_number;
                if (input.data.component_image !== undefined) componentUpdates['label_components.data.$[elem].component_image'] = input.data.component_image;
                if (input.data.specification_details !== undefined) componentUpdates['label_components.data.$[elem].dimensions'] = input.data.specification_details;

                updateQuery = { $set: componentUpdates };
                const componentArrayFilters = [{ 'elem._id': new ObjectId(input.data.component_id) }];
                updatedData = input.data;

                const updateResult = await db.collection<Product>('products').updateOne(
                    { _id: new ObjectId(input.id) },
                    updateQuery,
                    { arrayFilters: componentArrayFilters }
                );

                if (updateResult.matchedCount === 0) {
                    return ResponseWrapper.notFound('Product not found');
                }

                if (updateResult.modifiedCount === 0) {
                    return ResponseWrapper.badRequest('Label component could not be updated. Component ID may not exist.');
                }
                break;

            case 'delete_label_component':
                if (input.tab !== 'label-components') {
                    return ResponseWrapper.badRequest('Action delete_label_component must be used with tab label-components');
                }
                
                if (!input.data.component_id) {
                    return ResponseWrapper.badRequest('Missing required field: component_id is required');
                }
                
                if (!ObjectId.isValid(input.data.component_id)) {
                    return ResponseWrapper.badRequest('Invalid component_id format. Must be a valid MongoDB ObjectId.');
                }
                
                updateQuery = { $pull: { 'label_components.data': { _id: new ObjectId(input.data.component_id) } } };
                updatedData = { component_id: input.data.component_id };
                break;

            case 'update_label_components_tab_completion':
                if (input.tab !== 'label-components') {
                    return ResponseWrapper.badRequest('Action update_label_components_tab_completion must be used with tab label-components');
                }
                
                if (typeof input.data.tab_completed !== 'boolean') {
                    return ResponseWrapper.badRequest('tab_completed must be a boolean value');
                }
                
                updateQuery = { $set: { 'label_components.tab_completed': input.data.tab_completed } };
                updatedData = { tab_completed: input.data.tab_completed };
                break;

            case 'add_symbols_graphics_item':
                if (input.tab !== 'symbols-graphics') {
                    return ResponseWrapper.badRequest('Action add_symbols_graphics_item must be used with tab symbols-graphics');
                }
                
                if (!input.data.image || !input.data.text || !Array.isArray(input.data.label_presence) || !input.data.entity) {
                    return ResponseWrapper.badRequest('Missing required fields: image, text, label_presence array, and entity are required');
                }
                
                const validEntities = ['Symbols', 'Schematics', 'Barcodes', 'Other Components'];
                if (!validEntities.includes(input.data.entity)) {
                    return ResponseWrapper.badRequest(`Invalid entity. Must be one of: ${validEntities.join(', ')}`);
                }
                
                const newSymbolGraphic = {
                    _id: new ObjectId(),
                    image: input.data.image,
                    text: input.data.text,
                    description: input.data.description || null,
                    text_present: input.data.text_present !== false,
                    label_presence: input.data.label_presence,
                    entity: input.data.entity as 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components'
                };
                
                updateQuery = { $push: { 'symbols_graphics.data': newSymbolGraphic } };
                updatedData = newSymbolGraphic;
                break;

            case 'update_symbols_graphics_item':
                if (input.tab !== 'symbols-graphics') {
                    return ResponseWrapper.badRequest('Action update_symbols_graphics_item must be used with tab symbols-graphics');
                }
                
                if (!input.data.graphics_id) {
                    return ResponseWrapper.badRequest('Missing required field: graphics_id is required');
                }
                
                if (!ObjectId.isValid(input.data.graphics_id)) {
                    return ResponseWrapper.badRequest('Invalid graphics_id format. Must be a valid MongoDB ObjectId.');
                }
                
                const symbolUpdates: any = {};
                if (input.data.image !== undefined) symbolUpdates['symbols_graphics.data.$[elem].image'] = input.data.image;
                if (input.data.text !== undefined) symbolUpdates['symbols_graphics.data.$[elem].text'] = input.data.text;
                if (input.data.description !== undefined) symbolUpdates['symbols_graphics.data.$[elem].description'] = input.data.description;
                if (input.data.text_present !== undefined) symbolUpdates['symbols_graphics.data.$[elem].text_present'] = input.data.text_present;
                if (input.data.label_presence !== undefined) symbolUpdates['symbols_graphics.data.$[elem].label_presence'] = input.data.label_presence;
                if (input.data.entity !== undefined) {
                    const validEntities = ['Symbols', 'Schematics', 'Barcodes', 'Other Components'];
                    if (!validEntities.includes(input.data.entity)) {
                        return ResponseWrapper.badRequest(`Invalid entity. Must be one of: ${validEntities.join(', ')}`);
                    }
                    symbolUpdates['symbols_graphics.data.$[elem].entity'] = input.data.entity;
                }
                
                updateQuery = { $set: symbolUpdates };
                const symbolArrayFilters = [{ 'elem._id': new ObjectId(input.data.graphics_id) }];
                updatedData = input.data;
                
                await db.collection<Product>('products').updateOne(
                    { _id: new ObjectId(input.id) },
                    updateQuery,
                    { arrayFilters: symbolArrayFilters }
                );
                break;

            case 'delete_symbols_graphics_item':
                if (input.tab !== 'symbols-graphics') {
                    return ResponseWrapper.badRequest('Action delete_symbols_graphics_item must be used with tab symbols-graphics');
                }
                
                if (!input.data.graphics_id) {
                    return ResponseWrapper.badRequest('Missing required field: graphics_id is required');
                }
                
                if (!ObjectId.isValid(input.data.graphics_id)) {
                    return ResponseWrapper.badRequest('Invalid graphics_id format. Must be a valid MongoDB ObjectId.');
                }
                
                updateQuery = { $pull: { 'symbols_graphics.data': { _id: new ObjectId(input.data.graphics_id) } } };
                updatedData = { graphics_id: input.data.graphics_id };
                break;

            case 'update_symbols_graphics_tab_completion':
                if (input.tab !== 'symbols-graphics') {
                    return ResponseWrapper.badRequest('Action update_symbols_graphics_tab_completion must be used with tab symbols-graphics');
                }

                if (typeof input.data.tab_completed !== 'boolean') {
                    return ResponseWrapper.badRequest('tab_completed must be a boolean value');
                }

                updateQuery = { $set: { 'symbols_graphics.tab_completed': input.data.tab_completed } };
                updatedData = { tab_completed: input.data.tab_completed };
                break;

            case 'update_product_data':
                if (input.tab !== 'product-data') {
                    return ResponseWrapper.badRequest('Action update_product_data must be used with tab product-data');
                }

                if (input.data.workbook_data === undefined) {
                    return ResponseWrapper.badRequest('workbook_data is required');
                }

                updateQuery = { $set: { 'product_data.workbook_data': input.data.workbook_data } };
                updatedData = { workbook_data: input.data.workbook_data };
                break;

            case 'update_product_data_tab_completion':
                if (input.tab !== 'product-data') {
                    return ResponseWrapper.badRequest('Action update_product_data_tab_completion must be used with tab product-data');
                }

                if (typeof input.data.tab_completed !== 'boolean') {
                    return ResponseWrapper.badRequest('tab_completed must be a boolean value');
                }

                updateQuery = { $set: { 'product_data.tab_completed': input.data.tab_completed } };
                updatedData = { tab_completed: input.data.tab_completed };
                break;

            default:
                return ResponseWrapper.badRequest('Invalid action');
        }

        // Perform the update if it hasn't been done in the switch case
        if (!['update_custom_field', 'update_label_component', 'update_symbols_graphics_item', 'update_compliance_standard'].includes(input.action)) {
            await db.collection<Product>('products').updateOne(
                { _id: new ObjectId(input.id) },
                updateQuery
            );
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'product',
            entityId: input.id,
            action: AuditLogAction.UPDATE,
            actionBy: 'system', // This should be replaced with actual user ID from authentication
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Product data updated successfully',
            action: input.action,
            tab: input.tab,
            updated_data: updatedData
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};