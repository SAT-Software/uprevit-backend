import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchExportImage, resolveImageUrl } from '../../utils/productExportAssets';
import { toPersistedUploadKey, withPersistedUploadKeys } from '../../utils/s3-storage';
import { updateLabelTagTaggedImage } from '../../controllers/products/productData/label-tags';

const SIGNED = 'https://uploads-bucket.s3.us-east-1.amazonaws.com/uploads/ws/a.png?X-Amz-Signature=x';

describe('export image resolution', () => {
	const signedUrlMap = new Map([['uploads/ws/a.png', SIGNED]]);

	it('returns only signed URLs from the map', () => {
		expect(resolveImageUrl('uploads/ws/a.png', undefined, signedUrlMap)).toBe(SIGNED);
		expect(resolveImageUrl('', 'uploads/ws/a.png', signedUrlMap)).toBe(SIGNED);
	});

	it('never returns raw stored strings', () => {
		expect(resolveImageUrl('http://169.254.169.254/latest/meta-data/', undefined, signedUrlMap)).toBeUndefined();
		expect(resolveImageUrl('http://127.0.0.1:9/x', 'uploads/ws/missing.png', signedUrlMap)).toBeUndefined();
	});
});

describe('persisted upload keys', () => {
	it('keeps tenant upload keys and drops other references', () => {
		expect(toPersistedUploadKey('uploads/ws/a.png')).toBe('uploads/ws/a.png');
		expect(toPersistedUploadKey(SIGNED)).toBe('uploads/ws/a.png');
		expect(toPersistedUploadKey('http://169.254.169.254/latest/meta-data/')).toBe('');
		expect(toPersistedUploadKey({ $ne: null })).toBe('');
		expect(toPersistedUploadKey(undefined)).toBeUndefined();
	});

	it('sanitizes only the listed fields that are present', () => {
		expect(withPersistedUploadKeys({ image: 'http://evil/x', name: 'n' }, ['image', 'key'])).toEqual({ image: '', name: 'n' });
	});

	it('rejects a tagged image that is not a tenant upload', () => {
		const result = updateLabelTagTaggedImage(
			{ id: '507f1f77bcf86cd799439011', tagged_image: 'http://127.0.0.1/x' },
			'label-tags',
			'update_label_tag_tagged_image',
		);

		expect(result.error?.statusCode).toBe(400);
	});
});

describe('fetchExportImage', () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('does not fetch URLs outside the S3 allowlist', async () => {
		const fetchMock = jest.fn<typeof fetch>();
		global.fetch = fetchMock;

		await expect(fetchExportImage('http://169.254.169.254/latest/meta-data/')).resolves.toBeNull();
		await expect(fetchExportImage('https://example.com/a.png')).resolves.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fetches with no redirects and a deadline', async () => {
		const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
		global.fetch = fetchMock;

		const result = await fetchExportImage(SIGNED);

		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
		expect(fetchMock).toHaveBeenCalledWith(SIGNED, expect.objectContaining({ redirect: 'error', signal: expect.anything() }));
	});

	it('stops reading responses over the size cap', async () => {
		global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(26 * 1024 * 1024)));

		await expect(fetchExportImage(SIGNED)).resolves.toBeNull();
	});
});
