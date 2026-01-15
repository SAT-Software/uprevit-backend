import { PDFDocument, rgb, StandardFonts, PDFPage } from "pdf-lib";
import { Product } from "../models/product";
import transformUniverExcelData from "./transformUniverExcelData";

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 20;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);
const ROW_HEIGHT = 25;
const HEADER_HEIGHT = 25;
const FOOTER_HEIGHT = 25;

// Light blue header color matching Excel (C9DAF8)
const HEADER_BG_COLOR = rgb(0.788, 0.855, 0.973);
const HEADER_TEXT_COLOR = rgb(0, 0, 0);
const BORDER_COLOR = rgb(0, 0, 0);

export async function generateProductPDFExport(productData: Product) {
    try {
        const pdfDoc = await PDFDocument.create();
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const productName = productData.product_name || 'Product Export';
        
        // Track all pages for adding headers/footers at the end
        const pages: PDFPage[] = [];

        let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        pages.push(page);
        let y = PAGE_HEIGHT - MARGIN - HEADER_HEIGHT;

        const addNewPage = () => {
            page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            pages.push(page);
            y = PAGE_HEIGHT - MARGIN - HEADER_HEIGHT;
            return page;
        };

        const drawTextInCell = (text: string, x: number, cellY: number, width: number, isBold: boolean, currentPage: PDFPage) => {
            const size = 9;
            const font = isBold ? fontBold : fontRegular;
            let cleanText = String(text || '').replace(/\s+/g, ' ').trim();
            
            const textWidth = font.widthOfTextAtSize(cleanText, size);
            if (textWidth > width - 8) {
                const maxChars = Math.floor((width - 8) / 5);
                cleanText = cleanText.substring(0, maxChars) + '...';
            }

            currentPage.drawText(cleanText, {
                x: x + 4, 
                y: cellY - 16, 
                size: size,
                font: font,
                color: rgb(0, 0, 0)
            });
        };

        const drawTable = (title: string, headers: { label: string, widthPct: number }[], rows: any[][], startNewPage: boolean = false) => {
            // Start a new page if requested
            if (startNewPage && pages.length > 0) {
                addNewPage();
            }

            // Check if we have enough space for title + header + at least one row
            if (y < MARGIN + FOOTER_HEIGHT + 80) {
                addNewPage();
            }
            
            // Draw section title
            page.drawText(title, { x: MARGIN, y: y, size: 14, font: fontBold, color: rgb(0.2, 0.3, 0.6) });
            y -= 20; // Reduced from 30 to 20

            const colWidths = headers.map(h => h.widthPct * CONTENT_WIDTH);

            const drawHeader = () => {
                // Draw header background with light blue
                page.drawRectangle({ 
                    x: MARGIN, 
                    y: y - 20, 
                    width: CONTENT_WIDTH, 
                    height: 20, 
                    color: HEADER_BG_COLOR,
                    borderColor: BORDER_COLOR,
                    borderWidth: 1
                });
                
                let currentX = MARGIN;
                headers.forEach((h, i) => {
                    // Draw cell border
                    page.drawRectangle({
                        x: currentX,
                        y: y - 20,
                        width: colWidths[i],
                        height: 20,
                        borderColor: BORDER_COLOR,
                        borderWidth: 0.5
                    });
                    
                    // Draw header text in black
                    const fontSize = 9;
                    let headerText = h.label;
                    const textWidth = fontBold.widthOfTextAtSize(headerText, fontSize);
                    if (textWidth > colWidths[i] - 8) {
                        const maxChars = Math.floor((colWidths[i] - 8) / 5);
                        headerText = headerText.substring(0, maxChars) + '...';
                    }
                    
                    page.drawText(headerText, {
                        x: currentX + 4, 
                        y: y - 14,
                        size: fontSize, 
                        font: fontBold, 
                        color: HEADER_TEXT_COLOR
                    });
                    currentX += colWidths[i];
                });
                y -= 20;
            };

            drawHeader();

            rows.forEach((row, rowIndex) => {
                if (y < MARGIN + FOOTER_HEIGHT + ROW_HEIGHT) { 
                    addNewPage();
                    drawHeader();
                }

                // Draw Zebra Striping
                if (rowIndex % 2 === 1) {
                    page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: CONTENT_WIDTH, height: ROW_HEIGHT, color: rgb(0.96, 0.96, 0.96) });
                }

                let currentX = MARGIN;
                row.forEach((cellData, colIndex) => {
                    page.drawRectangle({
                        x: currentX, 
                        y: y - ROW_HEIGHT, 
                        width: colWidths[colIndex], 
                        height: ROW_HEIGHT,
                        borderColor: BORDER_COLOR, 
                        borderWidth: 0.5
                    });
                    
                    drawTextInCell(cellData, currentX, y, colWidths[colIndex], false, page);
                    
                    currentX += colWidths[colIndex];
                })

                y -= ROW_HEIGHT;
            });

            y -= 25; 
        };


        const infoRows = [];
        infoRows.push(['Product Name', productData.product_name || '']);
        infoRows.push(['Product Description', productData.product_description || '']);
        infoRows.push(['Product Plan Number', productData.product_plan_number || '']);
        
        if (productData.product_information?.data) {
            const d = productData.product_information.data;
            infoRows.push(['Market Geography', d.market_geography]);
            infoRows.push(['Country of Origin', d.country_of_origin]);
            infoRows.push(['OEM/Contract', d.oem_contract_manufacturer]);
            infoRows.push(['Commercial/Clinical', d.commercial_clinical]);
            infoRows.push(['Manufacturing Location', d.manufacturing_location]);
        }
        (productData.product_information?.custom_fields || []).forEach(f => infoRows.push([f.label, f.value]));
        
        drawTable('Product Information', 
            [{ label: 'Field', widthPct: 0.3 }, { label: 'Value', widthPct: 0.7 }], 
            infoRows,
            false // Don't start new page for first section
        );

        // 2. Compliance (New Page)
        const complianceRows = (productData.compliance_information?.data || []).map((item: any) => [
            item.standard, item.standard_description
        ]);
        drawTable('Compliance Information', 
            [{ label: 'Standard', widthPct: 0.3 }, { label: 'Description', widthPct: 0.7 }], 
            complianceRows,
            true // Start new page
        );

        // 3. Label Components (New Page)
        const labelComponentsRows = (productData.label_components?.data || []).map((item: any) => [
            item.component_number, item.image, item.component_description, item.label_type?.toString(), item.dimensions, item.component_type?.toString()
        ]);
        drawTable('Label Components',
            [
                { label: 'Component #', widthPct: 0.10 },
                { label: 'Image', widthPct: 0.18 },
                { label: 'Description', widthPct: 0.28 },
                { label: 'Label Type', widthPct: 0.16 },
                { label: 'Dimensions', widthPct: 0.14 },
                { label: 'Component Type', widthPct: 0.14 },
            ],
            labelComponentsRows,
            true // Start new page
        );

        // 4. Symbols (New Page)
        const symbolsRows = (productData.symbols_graphics?.data?.filter(data => data.entity === 'Symbols') || []).map((item: any) => [
            item.text, item.image, item.text_present, item.label_presence
        ]);
        drawTable('Symbols',
            [
                { label: 'Name', widthPct: 0.25 },
                { label: 'Image', widthPct: 0.25 },
                { label: 'Text Present', widthPct: 0.25 },
                { label: 'Label Presence', widthPct: 0.25 },
            ],
            symbolsRows,
            true // Start new page
        );

        
        // 5. Schematics (New Page)
        const schematicsRows = (productData.symbols_graphics?.data?.filter(data => data.entity === 'Schematics') || []).map((item: any) => [
            item.text, item.image, item.label_presence, item.description
        ]);
        drawTable('Schematics',
            [
                { label: 'Name', widthPct: 0.20 },
                { label: 'Image', widthPct: 0.20 },
                { label: 'Label Presence', widthPct: 0.25 },
                { label: 'Description', widthPct: 0.35 },
            ],
            schematicsRows,
            true // Start new page
        );

        // 6. Barcodes (New Page)
        const barcodesRows = (productData.symbols_graphics?.data?.filter(data => data.entity === 'Barcodes') || []).map((item: any) => [
            item.text, item.image, item.label_presence, item.count?.toString() || 1, item.description
        ]);
        drawTable('Barcodes',
            [
                { label: 'Type', widthPct: 0.18 },
                { label: 'Image', widthPct: 0.18 },
                { label: 'Label Presence', widthPct: 0.22 },
                { label: 'Count', widthPct: 0.10 },
                { label: 'Description', widthPct: 0.32 },
            ],
            barcodesRows,
            true // Start new page
        );


        // 7. Other Components (New Page)
        const otherComponentsRows = (productData.symbols_graphics?.data?.filter(data => data.entity === 'Other Components') || []).map((item: any) => [
            item.text, item.image, item.label_presence, item.description
        ]);
        drawTable('Other Components',
            [
                { label: 'Name', widthPct: 0.20 },
                { label: 'Image', widthPct: 0.20 },
                { label: 'Label Presence', widthPct: 0.25 },
                { label: 'Description', widthPct: 0.35 },
            ],
            otherComponentsRows,
            true // Start new page
        );

        // 8. Product Specifications - Use first row as headers (New Page)
        const pData = transformUniverExcelData(productData.product_data?.data);
        if (pData.sheets.length > 0) {
            const rawData = pData.sheets[0].data;
            if (rawData.length > 0) {
                // Use the first row as headers
                const headerRow = rawData[0];
                const dataRows = rawData.slice(1);
                const colCount = headerRow.length;
                
                // Calculate dynamic widths based on column count
                const dynamicHeaders = headerRow.map((headerText: any, i: number) => ({ 
                    label: String(headerText || `Column ${i+1}`), 
                    widthPct: 1 / colCount 
                }));
                
                drawTable('Product Specifications', dynamicHeaders, dataRows, true);
            }
        }

         // 9. Operational Parameters - Use first row as headers (New Page)
        const opData = transformUniverExcelData(productData.operational_parameters?.data);
        if (opData.sheets.length > 0) {
            const rawData = opData.sheets[0].data;
            if (rawData.length > 0) {
                // Use the first row as headers
                const headerRow = rawData[0];
                const dataRows = rawData.slice(1);
                const colCount = headerRow.length;
                
                // Calculate dynamic widths based on column count
                const dynamicHeaders = headerRow.map((headerText: any, i: number) => ({ 
                    label: String(headerText || `Column ${i+1}`), 
                    widthPct: 1 / colCount 
                }));
                
                drawTable('Operational Parameters', dynamicHeaders, dataRows, true);
            }
        }

        // 10. Label Tags (New Page)
        const labelTagsRows = (productData.label_tags?.data || []).map((item: any) => [
            item.name, item.description, item.type, item.image, item.tagged_image
        ]);
        drawTable('Label Tags',
            [
                { label: 'Name', widthPct: 0.15 },
                { label: 'Description', widthPct: 0.30 },
                { label: 'Type', widthPct: 0.15 },
                { label: 'Image', widthPct: 0.20 },
                { label: 'Tagged Image', widthPct: 0.20 },
            ],
            labelTagsRows,
            true // Start new page
        );

        // Add headers and footers to all pages
        const totalPages = pages.length;
        pages.forEach((p, index) => {
            const pageNumber = index + 1;
            
            // Header - Product name (top right)
            const headerText = productName;
            const headerFontSize = 10;
            const headerTextWidth = fontRegular.widthOfTextAtSize(headerText, headerFontSize);
            p.drawText(headerText, {
                x: PAGE_WIDTH - MARGIN - headerTextWidth,
                y: PAGE_HEIGHT - MARGIN + 5,
                size: headerFontSize,
                font: fontRegular,
                color: rgb(0.4, 0.4, 0.4)
            });

            // Footer - Page numbers (bottom right)
            const footerText = `Page ${pageNumber} of ${totalPages}`;
            const footerFontSize = 9;
            const footerTextWidth = fontRegular.widthOfTextAtSize(footerText, footerFontSize);
            p.drawText(footerText, {
                x: PAGE_WIDTH - MARGIN - footerTextWidth,
                y: MARGIN - 15,
                size: footerFontSize,
                font: fontRegular,
                color: rgb(0.4, 0.4, 0.4)
            });
        });

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        console.log(error);
        return null
    }
}