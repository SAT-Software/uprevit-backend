import { Product } from "../models/product";
require('core-js/modules/es.promise');
require('core-js/modules/es.string.includes');
require('core-js/modules/es.object.assign');
require('core-js/modules/es.object.keys');
require('core-js/modules/es.symbol');
require('core-js/modules/es.symbol.async-iterator');
require('regenerator-runtime/runtime');

const ExcelJS = require('exceljs/dist/es5');

export async function generateProductExcelExport(productData: Product) {
    try {
        // Create a new workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Uprevit';
        workbook.created = new Date();

    // 1. Product Info Sheet
        const productInfoSheet = workbook.addWorksheet('Product Info', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        productInfoSheet.columns = [
            { header: 'Field', key: 'field', width: 30 },
            { header: 'Value', key: 'value', width: 50 }
        ];

        const infoData = productData.product_information?.data;
        const infoRows: { field: string; value: string }[] = [];
        
        if (infoData) {
            infoRows.push(
                { field: 'Market Geography', value: infoData.market_geography || '' },
                { field: 'Country of Origin', value: infoData.country_of_origin || '' },
                { field: 'OEM Contract Manufacturer', value: infoData.oem_contract_manufacturer || '' },
                { field: 'Commercial/Clinical', value: infoData.commercial_clinical || '' }
            );
        }

        const customFields = productData.product_information?.custom_fields || [];
        customFields.forEach(field => {
            infoRows.push({ field: field.label, value: field.value });
        });

        productInfoSheet.addRows(infoRows);
        productInfoSheet.getRow(1).font = { bold: true };

    // 2. Compliance Info   
        const complianceInfoSheet = workbook.addWorksheet('Compliance Info', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        complianceInfoSheet.columns = [
            { header: 'Standard', key: 'standard', width: 30 },
            { header: 'Standard Description', key: 'standard_description', width: 50 }
        ]; 

        const ComplianceinfoData = productData.compliance_information?.data;
        const ComplianceinfoRows: { standard: string; standard_description: string }[] = [];

        ComplianceinfoData.map((item: any) => {
            ComplianceinfoRows.push(
                { standard: item.standard || '', standard_description: item.standard_description || '' }
            );
        });

        complianceInfoSheet.addRows(ComplianceinfoRows);
        complianceInfoSheet.getRow(1).font = { bold: true };

    // 3. Label Components
     const labelComponentsSheet = workbook.addWorksheet('Label Components', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        labelComponentsSheet.columns = [
            { header: 'Component Number', key: 'component_number', width: 30 },
            { header: 'Image', key: 'image', width: 50 },
            { header: 'Component Description', key: 'component_description', width: 50 },
            { header: 'Label Type', key: 'label_type', width: 50 },
            { header: 'Dimensions', key: 'dimensions', width: 50 },
            { header: 'Component Type', key: 'component_type', width: 50 }
        ]; 

        const labelComponentsData = productData.label_components?.data;
        const labelComponentsRows: { component_number: string; image: string; component_description: string; label_type: string[]; dimensions: string; component_type: string }[] = [];

        labelComponentsData.map((item: any) => {
            labelComponentsRows.push(
                { component_number: item.component_number || '', image: item.image || '', component_description: item.component_description || '', label_type: item.label_type.join(', ') || '', dimensions: item.dimensions || '', component_type: item.component_type || '' }
            );
        });

        labelComponentsSheet.addRows(labelComponentsRows);
        labelComponentsSheet.getRow(1).font = { bold: true };
    
    // 4. Symbols and Graphics - Symbols
    const symbolsSheet = workbook.addWorksheet('Symbols', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        symbolsSheet.columns = [
            { header: 'Text', key: 'text', width: 30 },
            { header: 'Image', key: 'image', width: 50 },
            { header: 'Entity', key: 'entity', width: 50 },
            { header: 'Text Present', key: 'text_present', width: 50 },
            { header: 'Label Presence', key: 'label_presence', width: 50 },
        ];

        const symbolsData = productData.symbols_graphics.data.filter(data => data.entity === 'Symbols');
        const symbolsRows: { text: string; image: string; entity: string; text_present: string; label_presence: string }[] = [];


        symbolsData.map((item: any) => {
            symbolsRows.push(
                { text: item.text || '', image: item.image || '', entity: item.entity || '', text_present: item.text_present || '', label_presence: item.label_presence.join(',') || '' }
            );
        });

        symbolsSheet.addRows(symbolsRows);
        symbolsSheet.getRow(1).font = { bold: true };

    // 5. Symbols and Graphics - Schematics
    const schematicsSheet = workbook.addWorksheet('Schematics', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        schematicsSheet.columns = [
            { header: 'Text', key: 'text', width: 30 },
            { header: 'Image', key: 'image', width: 50 },
            { header: 'Entity', key: 'entity', width: 50 },
            { header: 'Label Presence', key: 'label_presence', width: 50 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        const schematicsData = productData.symbols_graphics.data.filter(data => data.entity === 'Schematics');
        const schematicsRows: { text: string; image: string; entity: string; label_presence: string; description: string }[] = [];


        schematicsData.map((item: any) => {
            schematicsRows.push(
                { text: item.text || '', image: item.image || '', entity: item.entity || '', label_presence: item.label_presence.join(',')  || '', description: item.description || '' }
            );
        });

        schematicsSheet.addRows(schematicsRows);
        schematicsSheet.getRow(1).font = { bold: true };

    // 6. Symbols and Graphics - Barcodes
    const barcodesSheet = workbook.addWorksheet('Barcodes', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        barcodesSheet.columns = [
            { header: 'Text', key: 'text', width: 30 },
            { header: 'Image', key: 'image', width: 50 },
            { header: 'Entity', key: 'entity', width: 50 },
            { header: 'Label Presence', key: 'label_presence', width: 50 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        const barcodesData = productData.symbols_graphics.data.filter(data => data.entity === 'Barcodes');
        const barcodesRows: { text: string; image: string; entity: string; label_presence: string; description: string }[] = [];


        barcodesData.map((item: any) => {
            barcodesRows.push(
                { text: item.text || '', image: item.image || '', entity: item.entity || '', label_presence: item.label_presence.join(',')  || '', description: item.description || '' }
            );
        });

        barcodesSheet.addRows(barcodesRows);
        barcodesSheet.getRow(1).font = { bold: true };

    // 7. Symbols and Graphics - Other Components
    const otherComponentsSheet = workbook.addWorksheet('Other Components', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        otherComponentsSheet.columns = [
            { header: 'Text', key: 'text', width: 30 },
            { header: 'Image', key: 'image', width: 50 },
            { header: 'Entity', key: 'entity', width: 50 },
            { header: 'Label Presence', key: 'label_presence', width: 50 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        const otherComponentsData = productData.symbols_graphics.data.filter(data => data.entity === 'Other Components');
        const otherComponentsRows: { text: string; image: string; entity: string; label_presence: string; description: string }[] = [];


        otherComponentsData.map((item: any) => {
            otherComponentsRows.push(
                { text: item.text || '', image: item.image || '', entity: item.entity || '', label_presence: item.label_presence.join(',') || '', description: item.description || '' }
            );
        });

        otherComponentsSheet.addRows(otherComponentsRows);
        otherComponentsSheet.getRow(1).font = { bold: true };

    // 10. Label Tags
    const labelTagsSheet = workbook.addWorksheet('Label Tags', {
            pageSetup: { paperSize: 9, orientation: 'landscape' }
        });

        labelTagsSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 50 },
            { header: 'Type', key: 'type', width: 50 },
            { header: 'Image', key: 'image', width: 50 },
        ];

        const labelTagsData = productData.label_tags.data;
        const labelTagsRows: { name: string; description: string; type: string; image: string }[] = [];


        labelTagsData.map((item: any) => {
            labelTagsRows.push(
                { name: item.name || '', description: item.description || '', type: item.type || '', image: item.image || '' }
            );
        });

        labelTagsSheet.addRows(labelTagsRows);
        labelTagsSheet.getRow(1).font = { bold: true };

        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    } catch (error) {
        console.log('Excel export error:', error);
        return null;
    }
}