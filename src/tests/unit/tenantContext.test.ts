import { ObjectId } from 'mongodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../utils/authUtils', () => ({
	authenticateRequest: jest.fn(),
}));

jest.mock('../../utils/authenticatedUser', () => ({
	getAuthenticatedUserContext: jest.fn(),
}));

const authUtils = jest.requireMock('../../utils/authUtils') as any;
const authenticatedUser = jest.requireMock('../../utils/authenticatedUser') as any;

const {
	requireTenantContext,
	assertWorkspaceMatch,
	tenantObjectIdFilter,
	tenantUserIdFilter,
	isWorkspaceAdmin,
} = require('../../utils/tenantContext');

describe('tenantContext', () => {
	const workspaceId = new ObjectId();
	const userId = new ObjectId();
	const event = { headers: { Authorization: 'Bearer token' } };

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('requireTenantContext', () => {
		it('returns auth error when token is invalid', async () => {
			authUtils.authenticateRequest.mockResolvedValue({
				isValid: false,
				error: { statusCode: 401, body: '{"message":"Unauthorized"}' },
			});

			const result = await requireTenantContext(event);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.response.statusCode).toBe(401);
			}
		});

		it('returns unauthorized when user context cannot be resolved', async () => {
			authUtils.authenticateRequest.mockResolvedValue({
				isValid: true,
				payload: { sub: 'cognito-sub' },
				token: 'token',
			});
			authenticatedUser.getAuthenticatedUserContext.mockResolvedValue(null);

			const result = await requireTenantContext(event);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(JSON.parse(result.response.body).message).toBe(
					'Unable to resolve authenticated user context',
				);
			}
		});

		it('returns tenant context when auth and workspace resolve', async () => {
			authUtils.authenticateRequest.mockResolvedValue({
				isValid: true,
				payload: { sub: 'cognito-sub', 'cognito:groups': ['admin', 'user'] },
				token: 'token',
			});
			authenticatedUser.getAuthenticatedUserContext.mockResolvedValue({
				userId,
				workspaceId,
			});

			const result = await requireTenantContext(event);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.context).toEqual({
					workspaceId,
					userId,
					cognitoSub: 'cognito-sub',
					cognitoGroups: ['admin', 'user'],
				});
			}
		});
	});

	describe('assertWorkspaceMatch', () => {
		it('returns null when workspace ids match', () => {
			expect(assertWorkspaceMatch(workspaceId.toString(), workspaceId)).toBeNull();
		});

		it('returns forbidden when workspace ids differ', () => {
			const mismatch = assertWorkspaceMatch(new ObjectId(), workspaceId);

			expect(mismatch?.statusCode).toBe(403);
			expect(JSON.parse(mismatch!.body).message).toContain('not authorized');
		});

		it('returns bad request when workspace id is malformed', () => {
			const mismatch = assertWorkspaceMatch('not-an-objectid', workspaceId);

			expect(mismatch?.statusCode).toBe(400);
			expect(JSON.parse(mismatch!.body).message).toContain('Invalid workspace id');
		});
	});

	describe('tenantObjectIdFilter', () => {
		it('builds _id and workspace_id filter', () => {
			const resourceId = new ObjectId();

			expect(tenantObjectIdFilter(resourceId, workspaceId)).toEqual({
				_id: resourceId,
				workspace_id: workspaceId,
			});
		});
	});

	describe('tenantUserIdFilter', () => {
		it('builds _id and workspaceId filter', () => {
			const resourceId = new ObjectId();

			expect(tenantUserIdFilter(resourceId, workspaceId)).toEqual({
				_id: resourceId,
				workspaceId,
			});
		});
	});

	describe('isWorkspaceAdmin', () => {
		it('detects admin group membership', () => {
			expect(isWorkspaceAdmin(['admin'])).toBe(true);
			expect(isWorkspaceAdmin(['user'])).toBe(false);
		});
	});
});
