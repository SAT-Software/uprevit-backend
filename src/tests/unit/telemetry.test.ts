import { describe, expect, it } from '@jest/globals';
import { redactError } from '../../utils/telemetry';

const parseError = (text: string): unknown => {
	try {
		JSON.parse(text);
	} catch (error) {
		return error;
	}
};

describe('redactError', () => {
	it('drops request text from JSON parse errors', () => {
		const safe = redactError(parseError('{"name": secret product}')) as Error;
		expect(safe.name).toBe('SyntaxError');
		expect(safe.message).toBe('Invalid JSON');
		expect(safe.stack).not.toContain('secret');
	});

	it('redacts quoted values and emails from other errors', () => {
		const error = new Error('E11000 duplicate key dup key: { product_name: "Secret \\"X\\" pump" } for a@b.com');
		expect((redactError(error) as Error).message).toBe('E11000 duplicate key dup key: { product_name: "[redacted]" } for [email]');
	});

	it('redacts plain string errors', () => {
		expect(redactError('failed for "Secret pump"')).toBe('failed for "[redacted]"');
	});
});
