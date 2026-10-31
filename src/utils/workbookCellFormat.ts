import type { Worksheet } from "exceljs";

export const workbookDateSerial = (value: string, date1904 = false): number | undefined => {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const time = Date.parse(value + "T00:00:00Z");
		if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return undefined;
		const days = time / 86400000;
		return date1904 ? days + 24107 : days + 25569 - (value < "1900-03-01" ? 1 : 0);
	}
	if (/^\d+(?:\.\d+)?$/.test(value) && Number(value) < 2958466) return Number(value);
	return undefined;
};

export interface WorkbookCellFormat {
	dateFormat?: string;
	dateDisplay?: string;
	dateRaw?: string;
	date1904?: boolean;
	bgColor?: string;
	textColor?: string;
	decimalPlaces?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	fontSize?: number;
	alignment?: "left" | "center" | "right";
	verticalAlignment?: "top" | "middle" | "bottom";
}

export const formatWorkbookExportValue = (value: unknown, format?: WorkbookCellFormat): string => {
	const raw = value == null ? "" : String(value);
	if (format?.dateFormat) {
		if (format.dateRaw === raw && format.dateDisplay !== undefined) return format.dateDisplay;
		const serial = workbookDateSerial(raw, format.date1904);
		if (serial !== undefined) {
			const date = new Date((serial - (format.date1904 ? 24107 : serial < 60 ? 25568 : 25569)) * 86400000);
			const iso = !format.date1904 && Math.floor(serial) === 60 ? "1900-02-29" : date.toISOString().slice(0, 10);
			if (format.dateFormat === "dd mmm yyyy") return `${iso.slice(8)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
			return iso;
		}
	}
	const places = format?.decimalPlaces;
	const number = Number(raw);
	if (typeof places !== "number" || !Number.isInteger(places) || places < 0 || places > 10 || !/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) || !Number.isFinite(number) || Math.abs(number) >= 1e15 || raw.replace(/[^0-9]/g, "").length > 15) return raw;
	return number.toFixed(places);
};

export const applyWorkbookCellFormats = (sheet: Worksheet, formats: Record<string, WorkbookCellFormat> = {}): void => {
	const color = (value?: string) => typeof value === "string" && /^#[a-f\d]{6}$/i.test(value) ? "FF" + value.slice(1).toUpperCase() : undefined;
	for (const [key, format] of Object.entries(formats)) {
		const [row, col] = key.split(",").map(Number);
		if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 5001 || col < 0 || col >= 150) continue;
		const cell = sheet.getCell(row + 1, col + 1);
		const textColor = color(format.textColor);
		const bgColor = color(format.bgColor);
		cell.font = {
			...cell.font,
			bold: format.bold === true,
			italic: format.italic === true,
			underline: format.underline === true,
			...([10, 12, 14, 16, 18, 20, 24].includes(format.fontSize ?? 0) ? { size: format.fontSize } : {}),
			...(textColor ? { color: { argb: textColor } } : {}),
		};
		if (bgColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
		if (format.alignment === "left" || format.alignment === "center" || format.alignment === "right") cell.alignment = { ...cell.alignment, horizontal: format.alignment };
		if (["top", "middle", "bottom"].includes(format.verticalAlignment ?? "")) cell.alignment = { ...cell.alignment, vertical: format.verticalAlignment };
		const raw = cell.value == null ? "" : String(cell.value);
		const serial = format.dateFormat ? workbookDateSerial(raw, format.date1904) : undefined;
		if (serial !== undefined) {
			cell.value = serial + (format.date1904 ? 1462 : 0);
			cell.numFmt = format.dateFormat!;
			cell.note = { texts: [{ text: "uprevit:raw:" + raw }, ...(format.date1904 ? [{ text: "\nuprevit:date1904" }] : [])] };
			continue;
		}
		if (typeof format.decimalPlaces === "number" && Number.isInteger(format.decimalPlaces) && format.decimalPlaces >= 0 && format.decimalPlaces <= 10) {
			cell.numFmt = `0${format.decimalPlaces ? "." + "0".repeat(format.decimalPlaces) : ""}`;
			if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && Math.abs(Number(raw)) < 1e15 && raw.replace(/[^0-9]/g, "").length <= 15) {
				cell.value = Number(raw);
				cell.note = { texts: [{ text: "uprevit:raw:" + raw }] };
			}
		}
	}
};

export interface WorkbookConditionalRule {
	rows: number[];
	columns: number[];
	operator: "gt" | "lt" | "eq" | "contains";
	value: string;
	bgColor?: string;
	textColor?: string;
}

export const createWorkbookFormatResolver = (rules: WorkbookConditionalRule[]) => {
	const compiled = rules.map(rule => ({ rule, rows: new Set(rule.rows), columns: new Set(rule.columns) }));
	const number = (raw: string) => /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && Math.abs(Number(raw)) < 1e15 && raw.replace(/[^0-9]/g, "").length <= 15 ? Number(raw) : undefined;
	return (row: number, col: number, raw: unknown, manual?: WorkbookCellFormat): WorkbookCellFormat => {
		let format = manual ?? {};
		const value = raw == null ? "" : String(raw);
		for (const { rule, rows, columns } of compiled) {
			if (!rows.has(row) || !columns.has(col)) continue;
			const a = number(value);
			const b = number(rule.value);
			const matches = rule.operator === "contains" ? value.toLowerCase().includes(rule.value.toLowerCase()) :
				a !== undefined && b !== undefined && (rule.operator === "gt" ? a > b : rule.operator === "lt" ? a < b : a === b);
			if (matches) format = { ...format, ...(rule.bgColor ? { bgColor: rule.bgColor } : {}), ...(rule.textColor ? { textColor: rule.textColor } : {}) };
		}
		return format;
	};
};
