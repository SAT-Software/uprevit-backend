require('core-js/modules/es.promise');
require('core-js/modules/es.string.includes');
require('core-js/modules/es.object.assign');
require('core-js/modules/es.object.keys');
require('core-js/modules/es.symbol');
require('core-js/modules/es.symbol.async-iterator');
require('regenerator-runtime/runtime');

const ExcelJS = require('exceljs/dist/es5');


export const applyStandardStyling = (worksheet: any) => {
  const headerStyle = {
    font: { name: 'Arial', size: 12, bold: true },
    fill: {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'C9DAF8' }
    },
    alignment: { vertical: 'middle', horizontal: 'center' }
  };

  const borderStyle = {
    top: { style: 'thin', color: { argb: '000000' } },
    left: { style: 'thin', color: { argb: '000000' } },
    bottom: { style: 'thin', color: { argb: '000000' } },
    right: { style: 'thin', color: { argb: '000000' } }
  };

  const headerRow = worksheet.getRow(1);
  headerRow.height = 25;
  
  headerRow.eachCell((cell: any) => {
    cell.font = headerStyle.font;
    cell.fill = headerStyle.fill;
    cell.alignment = headerStyle.alignment;
    cell.border = borderStyle;
  });

  // Apply borders to all data cells
  worksheet.eachRow((row: any, rowNumber: number) => {
    if (rowNumber === 1) return; // Skip header row (already styled)

    row.eachCell({ includeEmpty: false }, (cell: any) => {
      cell.border = borderStyle;
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    });
  });

  worksheet.columns.forEach((column: any) => {
    let maxLength = 0;
    if (column.header) {
        maxLength = column.header.toString().length;
    }
    
    column.eachCell && column.eachCell({ includeEmpty: false }, (cell: any, rowNumber: number) => {
        if (rowNumber > 10) return;
        const len = cell.value ? cell.value.toString().length : 0;
        if (len > maxLength) maxLength = len;
    });

    column.width = Math.min(Math.max(maxLength + 2, 10), 50);
  });
};
