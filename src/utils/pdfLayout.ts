import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFImage, PDFPage, RGB, degrees, rgb } from 'pdf-lib';
import interRegular from '../assets/fonts/Inter-Regular.ttf';
import interSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import { EXPORT_TONES, ExportTone, ReportFilter, formatExportTimestamp } from './exportFormatting';
import type { WorkbookCellFormat } from './workbookCellFormat';

export const PAGE_WIDTH = 842;
export const PAGE_HEIGHT = 595;
const MARGIN_X = 28;
const CHROME_BAND = 20;
const CHROME_SIZE = 8;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN_X - CHROME_BAND - 16;
const CONTENT_BOTTOM = MARGIN_X + CHROME_BAND + 16;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 6;
const BODY_SIZE = 8.5;
const SMALL_SIZE = 7.5;
const MIN_ROW_HEIGHT = 22;
const MAX_WRAP_CHARS = 6000;
const MAX_FILTER_CHIPS = 24;

const hex = (value: string): RGB => rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
const workbookColor = (value?: string) => (typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? hex(value) : undefined);

const COLORS = {
	ink: hex('#111827'),
	body: hex('#374151'),
	muted: hex('#6B7280'),
	faint: hex('#9CA3AF'),
	border: hex('#E5E7EB'),
	zebra: hex('#FAFAFB'),
	surface: hex('#F9FAFB'),
	headerFill: hex('#F5F0FF'),
	headerRule: hex('#D8C4FF'),
	headerText: hex('#3B0764'),
	subHeaderFill: hex('#FBF8FF'),
};

export type PdfImageAsset = { image?: PDFImage; placeholderText?: string };

export type PdfCell = {
	text?: string;
	subtext?: string;
	format?: WorkbookCellFormat;
	image?: PdfImageAsset;
	pill?: { text: string; tone: ExportTone };
	muted?: boolean;
};

export type PdfColumn = {
	label: string;
	weight: number;
	align?: 'left' | 'center' | 'right';
	format?: WorkbookCellFormat;
	maxLines?: number;
	imageHeight?: number;
};

type TableOptions = {
	subHeader?: PdfCell[];
	hideHeader?: boolean;
	minRowHeights?: number[];
	emptyText?: string;
};

const roundedRectPath = (width: number, height: number, radius: number): string => {
	const r = Math.min(radius, width / 2, height / 2);
	return `M${r} 0H${width - r}Q${width} 0 ${width} ${r}V${height - r}Q${width} ${height} ${width - r} ${height}H${r}Q0 ${height} 0 ${height - r}V${r}Q0 0 ${r} 0Z`;
};

/**
 * Creates a branded landscape PDF builder with page chrome, headings, cards and wrapped tables.
 * @param {string} title - Document title shown in the page header and metadata
 * @param {string} workspaceName - Workspace name shown on the left of the page header
 * @return {Promise<object>} Layout helpers and a finish function returning the PDF buffer
 */
export async function createPdfLayout(title: string, workspaceName = '') {
	const doc = await PDFDocument.create();
	doc.registerFontkit(fontkit);
	doc.setTitle(title);
	doc.setCreator('Uprevit');
	doc.setProducer('Uprevit');
	const regular = await doc.embedFont(interRegular, { subset: true });
	const bold = await doc.embedFont(interSemiBold, { subset: true });
	const glyphs = fontkit.create(Buffer.from(interRegular));
	const generatedAt = formatExportTimestamp();
	const pages: PDFPage[] = [];
	const widthCache = new Map<string, number>();
	let page!: PDFPage;
	let y = CONTENT_TOP;

	const measure = (text: string, font: PDFFont, size: number): number => {
		if (text.length > 80) return font.widthOfTextAtSize(text, size);
		const key = `${font === bold ? 'b' : 'r'}${size}|${text}`;
		let width = widthCache.get(key);
		if (width === undefined) {
			width = font.widthOfTextAtSize(text, size);
			widthCache.set(key, width);
		}
		return width;
	};

	const clean = (value: unknown): string => {
		const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
		return Array.from(text, (char) => (char === '\n' || glyphs.hasGlyphForCodePoint(char.codePointAt(0)!) ? char : '?')).join('');
	};

	const ellipsize = (text: string, font: PDFFont, size: number, maxWidth: number): string => {
		if (measure(text, font, size) <= maxWidth) return text;
		let end = text.length;
		while (end > 0 && measure(`${text.slice(0, end)}…`, font, size) > maxWidth) end -= 1;
		return `${text.slice(0, end).trimEnd()}…`;
	};

	const wrap = (value: unknown, font: PDFFont, size: number, maxWidth: number, maxLines = Infinity): string[] => {
		const lines: string[] = [];
		const maxChars = Math.ceil(maxWidth / (size * 0.2));
		for (const paragraph of clean(value).slice(0, MAX_WRAP_CHARS).split('\n')) {
			if (lines.length > maxLines) break;
			let line = '';
			for (const word of paragraph.split(' ')) {
				if (lines.length > maxLines) break;
				const candidate = line ? `${line} ${word}` : word;
				if (candidate.length <= maxChars && measure(candidate, font, size) <= maxWidth) {
					line = candidate;
					continue;
				}
				if (line) lines.push(line);
				line = word;
				while (line.length > 1 && lines.length <= maxLines && (line.length > maxChars || measure(line, font, size) > maxWidth)) {
					let low = 1;
					let high = Math.min(line.length - 1, maxChars);
					while (low < high) {
						const mid = Math.ceil((low + high) / 2);
						if (measure(line.slice(0, mid), font, size) <= maxWidth) low = mid;
						else high = mid - 1;
					}
					const cut = low;
					lines.push(line.slice(0, cut));
					line = line.slice(cut);
				}
			}
			lines.push(line);
		}
		if (lines.length <= maxLines) return lines;
		const kept = lines.slice(0, Math.max(1, maxLines));
		kept[kept.length - 1] = ellipsize(`${kept[kept.length - 1]} ${lines[kept.length]}`.slice(0, 400), font, size, maxWidth);
		return kept;
	};

	const lineHeight = (size: number) => size * 1.35;

	const text = (value: string, x: number, baseline: number, options: { size?: number; font?: PDFFont; color?: RGB; italic?: boolean; underline?: boolean; target?: PDFPage } = {}) => {
		const { size = BODY_SIZE, font = regular, color = COLORS.body, italic, underline, target = page } = options;
		if (!value) return;
		target.drawText(value, { x, y: baseline, size, font, color, ...(italic ? { ySkew: degrees(12) } : {}) });
		if (underline) target.drawLine({ start: { x, y: baseline - 1.2 }, end: { x: x + measure(value, font, size), y: baseline - 1.2 }, thickness: 0.5, color });
	};

	const roundedRect = (x: number, top: number, width: number, height: number, radius: number, options: { fill?: RGB; border?: RGB }) => {
		page.drawSvgPath(roundedRectPath(width, height, radius), {
			x,
			y: top,
			...(options.fill ? { color: options.fill } : {}),
			...(options.border ? { borderColor: options.border, borderWidth: 0.75 } : {}),
		});
	};

	const pillWidth = (label: string) => measure(clean(label), bold, SMALL_SIZE) + 12;

	const pill = (label: string, tone: ExportTone, x: number, top: number) => {
		const colors = EXPORT_TONES[tone];
		const value = clean(label);
		roundedRect(x, top, pillWidth(value), 14, 7, { fill: hex(colors.fill) });
		text(value, x + 6, top - 10, { size: SMALL_SIZE, font: bold, color: hex(colors.text) });
	};

	const drawPageHeader = (target: PDFPage) => {
		const baseline = PAGE_HEIGHT - MARGIN_X - CHROME_SIZE * 0.73;
		const label = ellipsize(clean(title), regular, CHROME_SIZE, CONTENT_WIDTH / 2 - 12);
		text(ellipsize(clean(workspaceName), bold, CHROME_SIZE, CONTENT_WIDTH / 2 - 12), MARGIN_X, baseline, { size: CHROME_SIZE, font: bold, color: COLORS.ink, target });
		text(label, PAGE_WIDTH - MARGIN_X - measure(label, regular, CHROME_SIZE), baseline, { size: CHROME_SIZE, color: COLORS.muted, target });
		target.drawLine({ start: { x: MARGIN_X, y: PAGE_HEIGHT - MARGIN_X - CHROME_BAND }, end: { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - MARGIN_X - CHROME_BAND }, thickness: 0.75, color: COLORS.border });
	};

	const newPage = () => {
		page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
		pages.push(page);
		drawPageHeader(page);
		y = CONTENT_TOP;
	};

	const ensureSpace = (height: number) => {
		if (y - height < CONTENT_BOTTOM) newPage();
	};

	newPage();

	const titleBlock = ({ heading, meta = [] }: { heading: string; meta?: string[] }) => {
		wrap(heading, bold, 20, CONTENT_WIDTH, 3).forEach((line) => {
			text(line, MARGIN_X, y - 18, { size: 20, font: bold, color: COLORS.ink });
			y -= 26;
		});
		y -= 2;
		const metaText = meta.filter(Boolean).map(clean).join('   ·   ');
		text(ellipsize(metaText, regular, 9, CONTENT_WIDTH), MARGIN_X, y - 10, { size: 9, color: COLORS.muted });
		y -= 30;
	};

	const stats = (items: Array<{ label: string; value: string | number }>) => {
		if (!items.length) return;
		const gap = 8;
		const height = 46;
		const width = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
		ensureSpace(height + 12);
		items.forEach((item, index) => {
			const x = MARGIN_X + index * (width + gap);
			roundedRect(x, y, width, height, 6, { fill: COLORS.surface, border: COLORS.border });
			text(ellipsize(clean(item.label), regular, SMALL_SIZE, width - 20), x + 10, y - 14, { size: SMALL_SIZE, color: COLORS.muted });
			text(clean(String(item.value)), x + 10, y - 35, { size: 15, font: bold, color: COLORS.ink });
		});
		y -= height + 14;
	};

	const filters = (items: ReportFilter[]) => {
		const pad = 10;
		const chipHeight = 16;
		const gap = 6;
		const maxRight = MARGIN_X + CONTENT_WIDTH - pad;
		const parts = (item: ReportFilter) => [
			{ value: ellipsize(clean(item.field).slice(0, 400), bold, SMALL_SIZE + 0.5, CONTENT_WIDTH / 4), font: bold, color: COLORS.ink },
			{ value: clean(item.operator), font: regular, color: COLORS.muted },
			...(item.value ? [{ value: ellipsize(clean(item.value).slice(0, 400), bold, SMALL_SIZE + 0.5, CONTENT_WIDTH / 2), font: bold, color: COLORS.ink }] : []),
		];
		const hidden = Math.max(0, items.length - MAX_FILTER_CHIPS);
		const more = `+${hidden} more`;
		const tokens: Array<{ width: number; join?: string; chip?: ReturnType<typeof parts> }> = items.length
			? items.slice(0, MAX_FILTER_CHIPS).flatMap((item) => {
				const chip = parts(item);
				const width = chip.reduce((sum, part) => sum + measure(part.value, part.font, SMALL_SIZE + 0.5), 0) + (chip.length - 1) * 4 + 16;
				return [{ chip, width: Math.min(width, CONTENT_WIDTH - pad * 2) }, ...(item.join ? [{ join: item.join, width: measure(item.join, bold, SMALL_SIZE) }] : [])];
			})
			: [{ join: 'All products (no filters)', width: measure('All products (no filters)', regular, SMALL_SIZE + 0.5) }];
		if (hidden) tokens.push({ join: more, width: measure(more, bold, SMALL_SIZE) });
		const positions: Array<{ x: number; line: number }> = [];
		let x = MARGIN_X + pad;
		let line = 0;
		tokens.forEach((token) => {
			if (x > MARGIN_X + pad && x + token.width > maxRight) {
				x = MARGIN_X + pad;
				line += 1;
			}
			positions.push({ x, line });
			x += token.width + gap;
		});
		const height = pad * 2 + 12 + (line + 1) * (chipHeight + gap) - gap;
		ensureSpace(height + 12);
		roundedRect(MARGIN_X, y, CONTENT_WIDTH, height, 6, { fill: COLORS.surface, border: COLORS.border });
		text('FILTERS', MARGIN_X + pad, y - pad - 6, { size: SMALL_SIZE - 0.5, font: bold, color: COLORS.muted });
		tokens.forEach((token, index) => {
			const top = y - pad - 12 - positions[index].line * (chipHeight + gap);
			let cursor = positions[index].x;
			if (!token.chip) {
				const isPlaceholder = !items.length;
				text(token.join ?? '', cursor, top - 11, { size: isPlaceholder ? SMALL_SIZE + 0.5 : SMALL_SIZE, font: isPlaceholder ? regular : bold, color: COLORS.muted });
				return;
			}
			roundedRect(cursor, top, token.width, chipHeight, 8, { fill: hex('#FFFFFF'), border: COLORS.border });
			cursor += 8;
			token.chip.forEach((part) => {
				text(part.value, cursor, top - 11, { size: SMALL_SIZE + 0.5, font: part.font, color: part.color });
				cursor += measure(part.value, part.font, SMALL_SIZE + 0.5) + 4;
			});
		});
		y -= height + 12;
	};

	const heading = (label: string, count?: number) => {
		ensureSpace(90);
		y -= 10;
		const value = clean(label);
		text(value, MARGIN_X, y - 11, { size: 12.5, font: bold, color: COLORS.ink });
		if (count !== undefined) pill(String(count), 'gray', MARGIN_X + 8 + measure(value, bold, 12.5), y);
		y -= 24;
	};

	const subheading = (label: string, caption?: string) => {
		ensureSpace(70);
		const value = clean(label);
		text(value, MARGIN_X, y - 9, { size: 10, font: bold, color: COLORS.body });
		if (caption) text(clean(caption), MARGIN_X + measure(value, bold, 10) + 8, y - 9, { size: SMALL_SIZE, color: COLORS.faint });
		y -= 18;
	};

	const emptyNote = (message: string) => {
		ensureSpace(36);
		roundedRect(MARGIN_X, y, CONTENT_WIDTH, 28, 6, { fill: COLORS.surface });
		text(clean(message), MARGIN_X + 12, y - 17.5, { size: BODY_SIZE, color: COLORS.muted });
		y -= 40;
	};

	const cellFont = (cell: PdfCell, fallbackBold = false) => {
		const size = [10, 12, 14, 16, 18, 20, 24].includes(cell.format?.fontSize ?? 0) ? cell.format!.fontSize! * 0.75 : BODY_SIZE;
		return { size, font: cell.format?.bold ?? fallbackBold ? bold : regular };
	};

	const table = (columns: PdfColumn[], rows: PdfCell[][], options: TableOptions = {}) => {
		const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0) || 1;
		const widths = columns.map((column) => (column.weight / totalWeight) * CONTENT_WIDTH);
		const innerWidth = (index: number) => Math.max(1, widths[index] - CELL_PAD_X * 2);
		const available = CONTENT_TOP - CONTENT_BOTTOM;

		type Layout = { height: number; cells: Array<{ lines: string[]; subLines: string[]; size: number; font: PDFFont; image?: { width: number; height: number } }> };

		const layoutRow = (cells: PdfCell[], header: boolean, cap: number, minHeight = 0): Layout => {
			const laidOut = columns.map((column, index) => {
				const cell = cells[index] ?? {};
				const { size, font } = header ? { size: cell.format?.fontSize ? cellFont(cell, true).size : SMALL_SIZE + 0.5, font: cell.format?.bold === false ? regular : bold } : cellFont(cell);
				const fit = Math.max(1, Math.floor((cap - CELL_PAD_Y * 2) / lineHeight(size)));
				const maxLines = header ? Math.min(4, fit) : fit;
				const image = cell.image?.image;
				if (image) {
					const scale = Math.min(innerWidth(index) / image.width, (column.imageHeight ?? 90) / image.height, 1.5);
					return { lines: [], subLines: [], size, font, image: { width: image.width * scale, height: image.height * scale } };
				}
				const value = cell.image ? cell.image.placeholderText ?? 'Image unavailable' : cell.pill ? '' : cell.text;
				return {
					lines: value ? wrap(value, font, size, innerWidth(index), Math.min(column.maxLines ?? Infinity, maxLines)) : [],
					subLines: cell.subtext ? wrap(cell.subtext, regular, SMALL_SIZE, innerWidth(index), 2) : [],
					size,
					font,
				};
			});
			const contentHeight = Math.max(
				...laidOut.map((cell, index) => {
					if (cell.image) return cell.image.height;
					if (cells[index]?.pill) return 14;
					return cell.lines.length * lineHeight(cell.size) + cell.subLines.length * lineHeight(SMALL_SIZE);
				}),
				0,
			);
			return { height: Math.min(cap, Math.max(header ? 20 : MIN_ROW_HEIGHT, minHeight, contentHeight + CELL_PAD_Y * 2)), cells: laidOut };
		};

		const drawRow = (cells: PdfCell[], layout: Layout, kind: 'header' | 'subheader' | 'body', zebra: boolean) => {
			const top = y;
			const bottom = y - layout.height;
			const rowFill = kind === 'header' ? COLORS.headerFill : kind === 'subheader' ? COLORS.subHeaderFill : zebra ? COLORS.zebra : undefined;
			if (rowFill) page.drawRectangle({ x: MARGIN_X, y: bottom, width: CONTENT_WIDTH, height: layout.height, color: rowFill });
			let x = MARGIN_X;
			columns.forEach((column, index) => {
				const cell = cells[index] ?? {};
				const laid = layout.cells[index];
				const width = widths[index];
				const fill = workbookColor(cell.format?.bgColor);
				page.drawRectangle({ x, y: bottom, width, height: layout.height, ...(fill ? { color: fill } : {}), borderColor: COLORS.border, borderWidth: 0.5 });
				const align = cell.format?.alignment ?? column.align ?? 'left';
				const vertical = cell.format?.verticalAlignment ?? 'middle';
				const blockHeight = laid.image?.height ?? (cell.pill ? 14 : laid.lines.length * lineHeight(laid.size) + laid.subLines.length * lineHeight(SMALL_SIZE));
				const blockTop = vertical === 'top' ? top - CELL_PAD_Y : vertical === 'bottom' ? bottom + CELL_PAD_Y + blockHeight : top - (layout.height - blockHeight) / 2;
				const alignX = (contentWidth: number) => (align === 'right' ? x + width - CELL_PAD_X - contentWidth : align === 'center' ? x + (width - contentWidth) / 2 : x + CELL_PAD_X);
				if (laid.image && cell.image?.image) {
					page.drawImage(cell.image.image, { x: alignX(laid.image.width), y: blockTop - laid.image.height, width: laid.image.width, height: laid.image.height });
				} else if (cell.pill) {
					pill(cell.pill.text, cell.pill.tone, alignX(pillWidth(cell.pill.text)), blockTop);
				} else {
					const color = workbookColor(cell.format?.textColor) ?? (kind === 'header' ? COLORS.headerText : kind === 'subheader' || cell.muted || cell.image ? COLORS.muted : COLORS.ink);
					let baseline = blockTop - laid.size * 1.05;
					laid.lines.forEach((line) => {
						text(line, alignX(measure(line, laid.font, laid.size)), baseline, { size: laid.size, font: laid.font, color, italic: cell.format?.italic || kind === 'subheader', underline: cell.format?.underline });
						baseline -= lineHeight(laid.size);
					});
					laid.subLines.forEach((line) => {
						text(line, alignX(measure(line, regular, SMALL_SIZE)), baseline + (laid.size - SMALL_SIZE) * 0.3, { size: SMALL_SIZE, color: COLORS.muted });
						baseline -= lineHeight(SMALL_SIZE);
					});
				}
				x += width;
			});
			page.drawLine({ start: { x: MARGIN_X, y: bottom }, end: { x: PAGE_WIDTH - MARGIN_X, y: bottom }, thickness: kind === 'body' ? 0.5 : 0.75, color: kind === 'header' ? COLORS.headerRule : COLORS.border });
			y = bottom;
		};

		const headerCells = columns.map((column) => ({ text: column.label, format: column.format }));
		const headerLayout = layoutRow(headerCells, true, available / 4);
		const subHeaderLayout = options.subHeader ? layoutRow(options.subHeader, false, available / 4) : undefined;
		const headerHeight = options.hideHeader ? 0 : headerLayout.height + (subHeaderLayout?.height ?? 0);
		const drawHeader = () => {
			if (options.hideHeader) return;
			drawRow(headerCells, headerLayout, 'header', false);
			if (options.subHeader && subHeaderLayout) drawRow(options.subHeader, subHeaderLayout, 'subheader', false);
		};

		const rowCap = available - headerHeight;
		const firstLayout = rows[0] ? layoutRow(rows[0], false, rowCap, options.minRowHeights?.[0]) : undefined;
		ensureSpace(headerHeight + (firstLayout?.height ?? MIN_ROW_HEIGHT));
		drawHeader();
		if (!rows.length) {
			text(clean(options.emptyText ?? 'No rows'), MARGIN_X + CELL_PAD_X, y - 14.5, { size: BODY_SIZE, color: COLORS.muted });
			y -= MIN_ROW_HEIGHT;
			page.drawRectangle({ x: MARGIN_X, y, width: CONTENT_WIDTH, height: MIN_ROW_HEIGHT, borderColor: COLORS.border, borderWidth: 0.5 });
		}
		rows.forEach((row, index) => {
			const layout = index === 0 && firstLayout ? firstLayout : layoutRow(row, false, rowCap, options.minRowHeights?.[index]);
			if (y - layout.height < CONTENT_BOTTOM) {
				newPage();
				drawHeader();
			}
			drawRow(row, layout, 'body', index % 2 === 1);
		});
		y -= 18;
	};

	const finish = async (): Promise<Buffer> => {
		pages.forEach((target, index) => {
			const label = `Page ${index + 1} of ${pages.length}`;
			target.drawLine({ start: { x: MARGIN_X, y: MARGIN_X + CHROME_BAND }, end: { x: PAGE_WIDTH - MARGIN_X, y: MARGIN_X + CHROME_BAND }, thickness: 0.75, color: COLORS.border });
			text(generatedAt, MARGIN_X, MARGIN_X, { size: CHROME_SIZE, color: COLORS.muted, target });
			text(label, PAGE_WIDTH - MARGIN_X - measure(label, regular, CHROME_SIZE), MARGIN_X, { size: CHROME_SIZE, color: COLORS.muted, target });
		});
		return Buffer.from(await doc.save());
	};

	return { doc, generatedAt, titleBlock, filters, stats, heading, subheading, emptyNote, table, finish };
}
