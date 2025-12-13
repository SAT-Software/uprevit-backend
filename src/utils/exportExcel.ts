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

        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    } catch (error) {
        console.log('Excel export error:', error);
        return null;
    }
}