import type { Worksheet } from "exceljs";

export interface WorkbookCellFormat {
	bgColor?: string;
	textColor?: string;
	decimalPlaces?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	fontSize?: number;
	alignment?: "left" | "center" | "right";
}

export const formatWorkbookExportValue = (value: unknown, format?: WorkbookCellFormat): string => {
	const raw = value == null ? "" : String(value);
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
		const raw = cell.value == null ? "" : String(cell.value);
		if (typeof format.decimalPlaces === "number" && Number.isInteger(format.decimalPlaces) && format.decimalPlaces >= 0 && format.decimalPlaces <= 10) {
			cell.numFmt = `0${format.decimalPlaces ? "." + "0".repeat(format.decimalPlaces) : ""}`;
			if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && Math.abs(Number(raw)) < 1e15 && raw.replace(/[^0-9]/g, "").length <= 15) {
				cell.value = Number(raw);
				cell.note = { texts: [{ text: "uprevit:raw:" + raw }] };
			}
		}
	}
};
