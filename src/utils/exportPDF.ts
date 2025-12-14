import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { Product } from "../models/product";

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2);
const ROW_HEIGHT = 25;

export async function generateProductPDFExport(productData: Product) {
    try {
        const pdfDoc = await PDFDocument.create();
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

       let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
       let y = PAGE_HEIGHT - MARGIN;

       const drawTextInCell = (text: string, x: number, y: number, width: number, isBold: boolean) => {
            const size = 9;
            const font = isBold ? fontBold : fontRegular;
            let cleanText = String(text || '').replace(/\s+/g, ' ').trim();
            
            const textWidth = font.widthOfTextAtSize(cleanText, size);
            if (textWidth > width - 8) {
                const maxChars = Math.floor((width - 8) / 5);
                cleanText = cleanText.substring(0, maxChars) + '...';
            }

            page.drawText(cleanText, {
                x: x + 4, 
                y: y - 16, 
                size: size,
                font: font,
                color: rgb(0, 0, 0)
            });
        };

        const drawTable = (title: string, headers: { label: string, widthPct: number }[], rows: any[][]) => {
            if (y < 80) {
                page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
                y = PAGE_HEIGHT - MARGIN;
            }
            
            page.drawText(title, { x: MARGIN, y: y, size: 14, font: fontBold, color: rgb(0.2, 0.3, 0.6) });
            y -= 30;

            const colWidths = headers.map(h => h.widthPct * CONTENT_WIDTH);

            const drawHeader = () => {
                page.drawRectangle({ x: MARGIN, y: y - 20, width: CONTENT_WIDTH, height: 20, color: rgb(0.2, 0.3, 0.6) });
                
                let currentX = MARGIN;
                headers.forEach((h, i) => {
                    page.drawText(h.label, {
                        x: currentX + 4, y: y - 14,
                        size: 10, font: fontBold, color: rgb(1, 1, 1)
                    });
                    currentX += colWidths[i];
                });
                y -= 20;
            };

            drawHeader();

            rows.forEach((row, rowIndex) => {
                if (y < MARGIN + 20) { 
                    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
                    y = PAGE_HEIGHT - MARGIN;
                    drawHeader();
                }

                // Draw Zebra Striping (Optional)
                if (rowIndex % 2 === 1) {
                    page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: CONTENT_WIDTH, height: ROW_HEIGHT, color: rgb(0.96, 0.96, 0.96) });
                }

                let currentX = MARGIN;
                row.forEach((cellData, colIndex) => {
                    page.drawRectangle({
                        x: currentX, y: y - ROW_HEIGHT, width: colWidths[colIndex], height: ROW_HEIGHT,
                        borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5
                    });
                    
                    drawTextInCell(cellData, currentX, y, colWidths[colIndex], false);
                    
                    currentX += colWidths[colIndex];
                })

                y -= ROW_HEIGHT;
            });

            y -= 40;
        };

        // 1. Product Info
        const infoRows = [];
        if (productData.product_information?.data) {
            const d = productData.product_information.data;
            infoRows.push(['Market Geography', d.market_geography]);
            infoRows.push(['Country of Origin', d.country_of_origin]);
            infoRows.push(['OEM/Contract', d.oem_contract_manufacturer]);
            infoRows.push(['Commercial/Clinical', d.commercial_clinical]);
        }
        (productData.product_information?.custom_fields || []).forEach(f => infoRows.push([f.label, f.value]));
        
        drawTable('Product Information', 
            [{ label: 'Field', widthPct: 0.3 }, { label: 'Value', widthPct: 0.7 }], 
            infoRows
        );

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        console.log(error);
        return null
    }
}