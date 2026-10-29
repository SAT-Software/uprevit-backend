import { formatWorkbookExportValue, WorkbookCellFormat, createWorkbookFormatResolver } from "./workbookCellFormat";

interface UniverCell {
    v?: string | number | boolean;  
    t?: number;                    
    s?: string;                     
    f?: string;                     
}

interface TransformedSheet {
    name: string;
    headerOffset?: number;
    data: (string | number | boolean | null)[][];
    merges: string[];
    formats?: Record<string, WorkbookCellFormat>;
    rowHeights?: Record<number, number>;
    columnWidths?: Record<number, number>;
}

interface TransformResult {
    sheets: TransformedSheet[];
}

/**
 * Transforms Univer spreadsheet data into a standardized format.
 * Converts cell data to a 2D array and merge ranges to Excel-style notation.
 * @param {any} data - Raw Univer workbook data with cellData and mergeData
 * @param {boolean} displayDecimals - Render decimal precision for text exports
 * @return {TransformResult} Transformed data with sheets array containing name, data, and merges
 */
export default function transformUniverExcelData(data: any, displayDecimals = false): TransformResult {
	if (!data || typeof data !== 'object') {
		return { sheets: [] };
	}

	const workbookData = data.workbook_data ?? data;
	if (!workbookData || typeof workbookData !== 'object') {
		return { sheets: [] };
	}

	if (Array.isArray(workbookData.sheets)) {
		return { sheets: workbookData.sheets.flatMap((sheet: any) => {
			const transformed = transformUniverExcelData(sheet.data, displayDecimals);
			return transformed.sheets.length ? transformed.sheets.map(item => ({ ...item, name: sheet.name })) : [{ name: sheet.name, data: [], merges: [] }];
		}) };
	}
	if (workbookData.cells && typeof workbookData.cells === 'object') {
		const { cells, headers = {}, columnTypes = {}, columnOrder = [], cellFormats = {}, rowOrder = [], rowHeights = {}, columnWidths = {}, conditionalRules = [] } = workbookData;
		const orderedRows = [...new Set<number>([...rowOrder, ...Array.from({ length: 5000 }, (_, row) => row)])].filter(row => Number.isInteger(row) && row >= 0 && row < 5000);
		const orderedColumns = [...new Set<number>([...columnOrder.map((id: string) => Number(id.replace("col-", ""))), ...Array.from({ length: 150 }, (_, col) => col)])].filter(col => Number.isInteger(col) && col >= 0 && col < 150);
		const rowPositions = new Map(orderedRows.map((row, index) => [row, index]));
		const columnPositions = new Map(orderedColumns.map((col, index) => [col, index]));
		let maxRow = -1;
		let maxCol = -1;
		[...Object.keys(cells), ...Object.keys(cellFormats)].forEach(key => {
			const [row, col] = key.split(",").map(Number);
			if (!rowPositions.has(row) || !columnPositions.has(col)) return;
			maxRow = Math.max(maxRow, rowPositions.get(row)!);
			maxCol = Math.max(maxCol, columnPositions.get(col)!);
		});
		Object.keys(rowHeights).forEach(key => {
			if (rowPositions.has(Number(key))) { maxRow = Math.max(maxRow, rowPositions.get(Number(key))!); maxCol = Math.max(0, maxCol); }
		});
		[...Object.keys(headers), ...Object.keys(columnTypes), ...Object.keys(columnWidths)].forEach(key => {
			if (columnPositions.has(Number(key))) maxCol = Math.max(maxCol, columnPositions.get(Number(key))!);
		});
		Object.keys(workbookData.headerRows?.formats ?? {}).forEach(key => {
			const [row, col] = key.split(",").map(Number);
			if (row >= 0 && row < workbookData.headerRows.count && columnPositions.has(col)) maxCol = Math.max(maxCol, columnPositions.get(col)!);
		});
		if (workbookData.headerRows?.count) maxCol = Math.max(0, maxCol);
		if (maxCol < 0) return { sheets: [] };
		const columns = orderedColumns.slice(0, maxCol + 1);
		const omitHeaders = !workbookData.headerRows?.count && workbookData.sheetLayout === 'cells' && !Object.keys(headers).length && !Object.values(columnTypes).some(type => type && type !== 'blank');
		const rows: TransformedSheet['data'] = omitHeaders ? [] : [columns.map(col => headers[col] || '')];
		if (!omitHeaders && (workbookData.headerRows?.count === 2 || Object.values(columnTypes).some(type => type && type !== 'blank'))) rows.push(columns.map(col => columnTypes[col] || ''));
		const dataOffset = rows.length;
		const formats: Record<string, WorkbookCellFormat> = {};
		const heights: Record<number, number> = { ...workbookData.headerRows?.heights };
		const widths: Record<number, number> = {};
		Object.entries(workbookData.headerRows?.formats ?? {}).forEach(([key, format]) => {
			const [row, col] = key.split(",").map(Number);
			const visualCol = columnPositions.get(col);
			if (visualCol !== undefined && row >= 0 && row < dataOffset) {
				formats[`${row},${visualCol}`] = format as WorkbookCellFormat;
				if (displayDecimals) rows[row][visualCol] = formatWorkbookExportValue(rows[row][visualCol], format as WorkbookCellFormat);
			}
		});
		const resolveFormat = createWorkbookFormatResolver(conditionalRules);
		for (let visualRow = 0; visualRow <= maxRow; visualRow++) {
			const row = orderedRows[visualRow];
			const height = rowHeights[row];
			if (typeof height === "number" && Number.isFinite(height)) heights[visualRow + dataOffset] = Math.max(24, Math.min(300, height));
			rows.push(columns.map((col, visualCol) => {
				const key = `${row},${col}`;
				const value = cells[key] ?? null;
				const format = resolveFormat(row, col, value, cellFormats[key]);
				if (Object.keys(format).length) formats[`${visualRow + dataOffset},${visualCol}`] = format;
				return displayDecimals ? formatWorkbookExportValue(value, format) : value;
			}));
		}
		columns.forEach((col, visualCol) => {
			const width = columnWidths[col];
			if (typeof width === "number" && Number.isFinite(width)) widths[visualCol] = Math.max(50, Math.min(500, width));
		});
		return { sheets: [{ name: 'Sheet1', headerOffset: dataOffset, data: rows, merges: [], formats, rowHeights: heights, columnWidths: widths }] };
	}

	const sheetsObj = workbookData.sheets;
	if (!sheetsObj || typeof sheetsObj !== 'object') {
		return { sheets: [] };
	}
    
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
			const rowCells = cellData[rowIdx] || {};
			const colIndices = Object.keys(rowCells).map(Number).filter(n => !isNaN(n));
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
