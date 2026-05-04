/* eslint-disable require-jsdoc */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

type ManifestRow = {
	title: string;
	standard: string;
	standard_description?: string;
	ref_number: string;
	image_file: string;
	sort_order?: string | number;
};

type StandardSymbolDoc = {
	title: string;
	standard: string;
	standard_description?: string;
	ref_number: string;
	image_key: string;
	active: boolean;
	sort_order?: number;
	created_at?: Date;
	updated_at: Date;
};

type Args = {
	manifest: string;
	imagesDir: string;
	bucket: string;
	prefix: string;
	dryRun: boolean;
};

const REQUIRED_FIELDS: Array<keyof ManifestRow> = ['title', 'standard', 'ref_number', 'image_file'];

const usage = [
	'Usage:',
	'  ts-node scripts/seedStandardSymbols.ts --manifest ./symbols.csv --images-dir ./images --bucket uprevit-standard-symbols --prefix standard-symbols --dry-run',
	'',
	'Required env:',
	'  MONGODB_URI, DB_NAME, AWS_REGION',
	'',
	'Manifest CSV/JSON fields:',
	'  title,standard,standard_description,ref_number,image_file,sort_order',
].join('\n');

const parseArgs = (): Args => {
	const args = process.argv.slice(2);
	const getValue = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};

	const manifest = getValue('--manifest');
	const imagesDir = getValue('--images-dir');
	const bucket = getValue('--bucket') || process.env.STANDARD_SYMBOLS_BUCKET;
	const prefix = getValue('--prefix') || 'standard-symbols';

	if (!manifest || !imagesDir || !bucket) {
		throw new Error(usage);
	}

	return {
		manifest,
		imagesDir,
		bucket,
		prefix,
		dryRun: args.includes('--dry-run'),
	};
};

const normalizeText = (value: string): string =>
	value.trim().replace(/\s+/g, ' ');

const normalizeIdentityPart = (value: string): string =>
	normalizeText(value).toLowerCase();

const sanitizeKeyPart = (value: string): string =>
	normalizeIdentityPart(value)
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') || 'unknown';

const parseOptionalText = (value: unknown): string | undefined => {
	if (typeof value !== 'string') return undefined;
	const normalized = normalizeText(value);
	return normalized ? normalized : undefined;
};

const parseSortOrder = (value: unknown): number | undefined => {
	if (value === undefined || value === null || value === '') return undefined;
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (!Number.isInteger(parsed)) throw new Error(`Invalid sort_order "${value}"`);
	return parsed;
};

const splitCsvLine = (line: string): string[] => {
	const values: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		const nextChar = line[i + 1];

		if (char === '"' && inQuotes && nextChar === '"') {
			current += '"';
			i += 1;
			continue;
		}

		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}

		if (char === ',' && !inQuotes) {
			values.push(current.trim());
			current = '';
			continue;
		}

		current += char;
	}

	values.push(current.trim());
	return values;
};

const parseCsv = (content: string): ManifestRow[] => {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));

	if (lines.length < 2) return [];

	const headers = splitCsvLine(lines[0]).map((header) => header.trim());

	return lines.slice(1).map((line) => {
		const values = splitCsvLine(line);
		return headers.reduce<Record<string, string>>((row, header, index) => {
			row[header] = values[index] ?? '';
			return row;
		}, {}) as ManifestRow;
	});
};

const readManifest = async (manifestPath: string): Promise<ManifestRow[]> => {
	const content = await readFile(manifestPath, 'utf8');
	const extension = path.extname(manifestPath).toLowerCase();

	if (extension === '.json') {
		const parsed = JSON.parse(content);
		if (!Array.isArray(parsed)) throw new Error('JSON manifest must be an array of rows.');
		return parsed as ManifestRow[];
	}

	if (extension === '.csv') return parseCsv(content);

	throw new Error('Manifest must be a .csv or .json file.');
};

const getContentType = (filePath: string): string => {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === '.svg') return 'image/svg+xml';
	if (extension === '.png') return 'image/png';
	if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
	if (extension === '.webp') return 'image/webp';
	return 'application/octet-stream';
};

const validateRow = async (row: ManifestRow, index: number, imagesDir: string): Promise<string[]> => {
	const errors: string[] = [];

	for (const field of REQUIRED_FIELDS) {
		if (!parseOptionalText(row[field])) {
			errors.push(`row ${index}: missing ${field}`);
		}
	}

	try {
		parseSortOrder(row.sort_order);
	} catch (error) {
		errors.push(`row ${index}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const imageFile = parseOptionalText(row.image_file);
	if (imageFile) {
		const imagePath = path.resolve(imagesDir, imageFile);
		try {
			const imageStat = await stat(imagePath);
			if (!imageStat.isFile()) errors.push(`row ${index}: image_file is not a file (${imageFile})`);
		} catch {
			errors.push(`row ${index}: image_file not found (${imageFile})`);
		}
	}

	return errors;
};

const buildImageKey = (row: ManifestRow, prefix: string): string => {
	const fileName = path.basename(normalizeText(row.image_file));
	const standard = sanitizeKeyPart(row.standard);
	const refNumber = sanitizeKeyPart(row.ref_number);
	return `${prefix.replace(/^\/|\/$/g, '')}/${standard}/${refNumber}/${fileName}`;
};

const toDocument = (row: ManifestRow, imageKey: string): StandardSymbolDoc => ({
	title: normalizeText(row.title),
	standard: normalizeText(row.standard),
	standard_description: parseOptionalText(row.standard_description),
	ref_number: normalizeText(row.ref_number),
	image_key: imageKey,
	active: true,
	sort_order: parseSortOrder(row.sort_order),
	updated_at: new Date(),
});

const sameDocument = (existing: Partial<StandardSymbolDoc> | null, next: StandardSymbolDoc): boolean => {
	if (!existing) return false;

	return existing.title === next.title
		&& existing.standard === next.standard
		&& existing.standard_description === next.standard_description
		&& existing.ref_number === next.ref_number
		&& existing.image_key === next.image_key
		&& existing.active === next.active
		&& existing.sort_order === next.sort_order;
};

async function run() {
	const args = parseArgs();
	const mongodbUri = process.env.MONGODB_URI;
	const dbName = process.env.DB_NAME;
	const region = process.env.AWS_REGION;

	if (!mongodbUri) throw new Error('MONGODB_URI environment variable is required.');
	if (!dbName) throw new Error('DB_NAME environment variable is required.');
	if (!region) throw new Error('AWS_REGION environment variable is required.');

	const rows = await readManifest(args.manifest);
	if (!rows.length) throw new Error('Manifest has no rows.');

	const validationErrors = (
		await Promise.all(rows.map((row, index) => validateRow(row, index + 2, args.imagesDir)))
	).flat();

	if (validationErrors.length) {
		for (const error of validationErrors) {
			// eslint-disable-next-line no-console
			console.error(error);
		}
		throw new Error(`Manifest validation failed with ${validationErrors.length} error(s).`);
	}

	const mongo = new MongoClient(mongodbUri, {
		serverApi: { version: ServerApiVersion.v1 },
	});
	const s3 = new S3Client({ region });

	await mongo.connect();
	const collection = mongo.db(dbName).collection<StandardSymbolDoc>('standard_symbols');

	let inserted = 0;
	let updated = 0;
	let unchanged = 0;
	let uploaded = 0;

	try {
		for (const row of rows) {
			const imageKey = buildImageKey(row, args.prefix);
			const nextDoc = toDocument(row, imageKey);
			const filter = {
				standard: nextDoc.standard,
				ref_number: nextDoc.ref_number,
			};
			const existing = await collection.findOne(filter);

			if (sameDocument(existing, nextDoc)) {
				unchanged += 1;
				continue;
			}

			if (args.dryRun) {
				if (existing) updated += 1;
				else inserted += 1;
				continue;
			}

			const imagePath = path.resolve(args.imagesDir, normalizeText(row.image_file));
			const body = await readFile(imagePath);

			await s3.send(new PutObjectCommand({
				Bucket: args.bucket,
				Key: imageKey,
				Body: body,
				ContentType: getContentType(imagePath),
			}));
			uploaded += 1;

			const result = await collection.updateOne(
				filter,
				{
					$set: nextDoc,
					$setOnInsert: { created_at: new Date() },
				},
				{ upsert: true },
			);

			if (result.upsertedCount > 0) inserted += 1;
			else updated += result.modifiedCount;
		}
	} finally {
		await mongo.close();
	}

	const label = args.dryRun ? '[dry-run]' : '[seed]';
	// eslint-disable-next-line no-console
	console.log(`${label} standard_symbols complete: rows=${rows.length}, inserted=${inserted}, updated=${updated}, unchanged=${unchanged}, uploaded=${uploaded}`);
}

run().catch((error) => {
	// eslint-disable-next-line no-console
	console.error('Standard symbol seed failed:', error instanceof Error ? error.message : error);
	process.exit(1);
});
