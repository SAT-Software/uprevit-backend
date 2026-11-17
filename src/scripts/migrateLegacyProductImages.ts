import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import crypto from 'node:crypto';
import { readResponseCapped } from '../utils/readResponseCapped';

/**
 * Copies legacy product images stored as external UploadThing URLs into the tenant uploads/ prefix
 * and stores the S3 key, so product exports and edits keep working now that only uploads/ keys are
 * accepted. Other non-key image values are reported and left untouched. Safe to run twice.
 *
 * Usage: MONGODB_URI=... DB_NAME=... UPLOADS_BUCKET=... AWS_PROFILE=... npm run migrate:legacy-product-images -- [--dry-run]
 */

const LEGACY_HOST = /(^|\.)(ufs\.sh|utfs\.io)$/;
const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_FIELDS: Record<string, Array<[string, string]>> = {
	label_components: [['image', 'key']],
	symbols_graphics: [['image', 'key']],
	label_tags: [['image', 'key'], ['tagged_image', 'tagged_image_key']],
};

type Item = Record<string, unknown>;
type ProductDoc = { _id: ObjectId; workspace_id: ObjectId } & Record<string, { data?: Item[] } | ObjectId>;

const detectImage = (bytes: Uint8Array): { ext: string; type: string } | null => {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ext: 'png', type: 'image/png' };
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
	if (Buffer.from(bytes.subarray(0, 4)).toString() === 'GIF8') return { ext: 'gif', type: 'image/gif' };
	if (Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') {
		return { ext: 'webp', type: 'image/webp' };
	}
	return null;
};

const isLegacyUrl = (value: unknown): value is string => {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && LEGACY_HOST.test(url.hostname);
	} catch {
		return false;
	}
};

const download = async (url: string): Promise<Uint8Array | null> => {
	const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
	return response.ok ? readResponseCapped(response, MAX_BYTES) : null;
};

const main = async () => {
	const { MONGODB_URI, DB_NAME, UPLOADS_BUCKET } = process.env;
	if (!MONGODB_URI || !DB_NAME || !UPLOADS_BUCKET) throw new Error('MONGODB_URI, DB_NAME and UPLOADS_BUCKET are required');
	const dryRun = process.argv.includes('--dry-run');

	const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
	const client = new MongoClient(MONGODB_URI, { serverApi: ServerApiVersion.v1 });
	await client.connect();
	try {
		const products = client.db(DB_NAME).collection<ProductDoc>('products');
		const copied = new Map<string, string | null>();
		const counts = { products: 0, items: 0, copied: 0, failed: 0, skipped: 0 };

		const copy = async (url: string, product: ProductDoc): Promise<string | null> => {
			const cacheKey = `${product.workspace_id}:${url}`;
			if (copied.has(cacheKey)) return copied.get(cacheKey)!;
			let key: string | null = null;
			const bytes = await download(url).catch(() => null);
			const image = bytes && detectImage(bytes);
			if (bytes && image) {
				key = `uploads/${product.workspace_id}/product/${product._id}/${crypto.randomUUID()}-legacy.${image.ext}`;
				if (!dryRun) {
					await s3.send(new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: key, Body: bytes, ContentType: image.type }));
				}
				counts.copied += 1;
			} else {
				counts.failed += 1;
				console.log(`  could not copy ${url.slice(0, 80)} (product ${product._id})`);
			}
			copied.set(cacheKey, key);
			return key;
		};

		for await (const product of products.find({})) {
			let changed = false;
			for (const [array, fields] of Object.entries(IMAGE_FIELDS)) {
				const items = (product[array] as { data?: Item[] } | undefined)?.data;
				if (!Array.isArray(items)) continue;
				for (const item of items) {
					for (const [imageField, keyField] of fields) {
						const value = item[imageField];
						if (item[keyField] || typeof value !== 'string' || !value || value.startsWith('uploads/')) continue;
						if (!isLegacyUrl(value)) {
							counts.skipped += 1;
							continue;
						}
						counts.items += 1;
						const key = await copy(value, product);
						if (!key || !item._id) continue;
						changed = true;
						if (dryRun) continue;
						await products.updateOne(
							{ _id: product._id },
							{ $set: { [`${array}.data.$[item].${imageField}`]: key, [`${array}.data.$[item].${keyField}`]: key } },
							{ arrayFilters: [{ 'item._id': item._id, [`item.${imageField}`]: value }] },
						);
					}
				}
			}
			if (changed) counts.products += 1;
		}

		console.log(`${DB_NAME}: ${dryRun ? 'would update' : 'updated'} ${counts.products} product versions, `
			+ `${counts.items} image references, ${counts.copied} copies, ${counts.failed} failed, ${counts.skipped} non-legacy values left as is`);
	} finally {
		await client.close();
	}
};

main().catch((error) => {
	console.error('Legacy product image migration failed', error);
	process.exit(1);
});
