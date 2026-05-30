import { ObjectId } from 'mongodb';
import { describe, expect, it } from '@jest/globals';

process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
process.env.UPLOADS_BUCKET = process.env.UPLOADS_BUCKET ?? 'test-uploads';
process.env.EXPORTS_BUCKET = process.env.EXPORTS_BUCKET ?? 'test-exports';

const {
	assertTenantUploadKeyAllowed,
	isTenantUploadKeyAllowed,
	TenantUploadKeyError,
} = require('../../utils/s3-storage');

describe('tenant upload key validation', () => {
	const workspaceId = new ObjectId();
	const otherWorkspaceId = new ObjectId();
	const pendingOwnerId = 'cognito-sub-123';

	const signingOptions = {
		workspaceId,
		pendingOwnerId,
	};

	it('allows workspace-scoped product asset keys', () => {
		const key = `uploads/${workspaceId.toString()}/product/507f1f77bcf86cd799439011/file.png`;

		expect(isTenantUploadKeyAllowed(key, signingOptions)).toBe(true);
		expect(() => assertTenantUploadKeyAllowed(key, signingOptions)).not.toThrow();
	});

	it('allows pending keys for the configured owner', () => {
		const key = `uploads/pending/${pendingOwnerId}/avatar.png`;

		expect(isTenantUploadKeyAllowed(key, signingOptions)).toBe(true);
	});

	it('rejects another workspace prefix', () => {
		const key = `uploads/${otherWorkspaceId.toString()}/workspace/logo.png`;

		expect(isTenantUploadKeyAllowed(key, signingOptions)).toBe(false);
		expect(() => assertTenantUploadKeyAllowed(key, signingOptions)).toThrow(TenantUploadKeyError);
	});

	it('rejects legacy unscoped uploads keys', () => {
		const key = 'uploads/legacy-file.png';

		expect(isTenantUploadKeyAllowed(key, signingOptions)).toBe(false);
	});

	it('rejects pending keys for a different owner', () => {
		const key = 'uploads/pending/other-user/avatar.png';

		expect(isTenantUploadKeyAllowed(key, signingOptions)).toBe(false);
	});
});
