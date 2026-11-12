import { describe, expect, it } from '@jest/globals';
import { escapeRegex } from '../../utils/regex';

describe('escapeRegex', () => {
	it('escapes regex metacharacters', () => {
		expect(escapeRegex('a.b*(c)')).toBe('a\\.b\\*\\(c\\)');
	});

	it('treats a catastrophic pattern as literal text', () => {
		const regex = new RegExp(`^${escapeRegex('(a+)+$')}$`);
		expect(regex.test('(a+)+$')).toBe(true);
		expect(regex.test('aaaa')).toBe(false);
	});
});
