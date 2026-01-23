interface UniverCell {
    v?: string | number | boolean;  
    t?: number;                    
    s?: string;                     
    f?: string;                     
}

interface TransformedSheet {
    name: string;
    data: (string | number | boolean | null)[][]; 
    merges: string[];                             
}

interface TransformResult {
    sheets: TransformedSheet[];
}

/**
 * Transforms Univer spreadsheet data into a standardized format.
 * Converts cell data to a 2D array and merge ranges to Excel-style notation.
 * @param {any} data - Raw Univer workbook data with cellData and mergeData
 * @return {TransformResult} Transformed data with sheets array containing name, data, and merges
 */
export default function transformUniverExcelData(data: any): TransformResult {
	const sheetsObj = data.workbook_data.sheets;
    
	const sheets: TransformedSheet[] = Object.values(sheetsObj).map((sheet: any) => {
		const cellData = sheet.cellData || {};
		const mergeData = sheet.mergeData || [];
        
		// Find the bounds of the data
		const rowIndices = Object.keys(cellData).map(Number).filter(n => !isNaN(n));
        
		if (rowIndices.length === 0) {
			return {
				name: sheet.name || 'Sheet',
				data: [],
				merges: []
			};
		}
        
		const maxRow = Math.max(...rowIndices);
        
		// Find max column across all rows
		let maxCol = 0;
		for (const rowIdx of rowIndices) {
			const colIndices = Object.keys(cellData[rowIdx]).map(Number).filter(n => !isNaN(n));
			if (colIndices.length > 0) {
				maxCol = Math.max(maxCol, ...colIndices);
			}
		}
        
		// Build the 2D array
		const rows: (string | number | boolean | null)[][] = [];
        
		for (let row = 0; row <= maxRow; row++) {
			const rowData: (string | number | boolean | null)[] = [];
            
			for (let col = 0; col <= maxCol; col++) {
				const cell: UniverCell | undefined = cellData[row]?.[col];
                
				if (cell && cell.v !== undefined) {
					rowData.push(cell.v);
				} else {
					rowData.push(null);
				}
			}
            
			rows.push(rowData);
		}
        
		// Convert merge data to Excel-style ranges (e.g., "A1:C3")
		const merges = mergeData.map((merge: any) => {
			const startCol = columnToLetter(merge.startColumn);
			const endCol = columnToLetter(merge.endColumn);
			const startRow = merge.startRow + 1; // Excel is 1-indexed
			const endRow = merge.endRow + 1;
			return `${startCol}${startRow}:${endCol}${endRow}`;
		});
        
		return {
			name: sheet.name || 'Sheet',
			data: rows,
			merges
		};
	});
    
	return { sheets };
}

/**
 * Converts a zero-based column index to Excel column letters.
 * @param {number} col - Zero-based column index (0 = A, 1 = B, 26 = AA)
 * @return {string} Excel-style column letter(s)
 */
function columnToLetter(col: number): string {
	let letter = '';
	let temp = col;
    
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
    
	return letter;
}