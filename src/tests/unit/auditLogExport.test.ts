import { describe, expect, it } from '@jest/globals';
import { buildAuditLogCsv } from '../../utils/auditLogExport';

describe('buildAuditLogCsv', () => {
	it('neutralises cells that Excel would treat as formulas', () => {
		const csv = buildAuditLogCsv([{
			occurredAt: new Date('2026-01-01T00:00:00.000Z'),
			action: 'update',
			eventKey: 'member.profile.updated',
			summary: '=HYPERLINK("http://example.com")',
			actor: { name: '+Mallory', email: 'm@example.com', role: 'user', userId: 'sub-1' },
			scope: { type: 'workspace', id: 'ws' },
			where: { module: 'users' },
		} as never]).toString('utf8');

		expect(csv).toContain(`"'=HYPERLINK(""http://example.com"")"`);
		expect(csv).toContain(`'+Mallory`);
	});
});
