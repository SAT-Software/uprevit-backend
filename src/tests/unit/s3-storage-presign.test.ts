import { describe, expect, it } from '@jest/globals';

process.env.AWS_ACCESS_KEY_ID = 'AKIATEST';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

const { createPresignedUrl } = require('../../utils/s3-storage');

describe('createPresignedUrl', () => {
	it('signs the exact upload size', async () => {
		const { uploadUrl } = await createPresignedUrl('a.png', 'image/png', {
			workspaceId: '6a0000000000000000000001',
			uploadScope: 'workspace-assets',
			sizeBytes: 1234,
		});

		expect(new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
	});
});
