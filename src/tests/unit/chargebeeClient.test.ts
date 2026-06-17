import { describe, expect, it } from '@jest/globals';
import { isChargebeeDuplicateCustomerError } from '../../utils/billing/chargebeeClient';

describe('chargebeeClient', () => {
	describe('isChargebeeDuplicateCustomerError', () => {
		it('returns true for Chargebee duplicate_entry JSON errors', () => {
			const error = new Error(JSON.stringify({
				api_error_code: 'duplicate_entry',
				error_code: 'param_not_unique',
			}));

			expect(isChargebeeDuplicateCustomerError(error)).toBe(true);
		});

		it('returns true for plain-text duplicate messages', () => {
			expect(isChargebeeDuplicateCustomerError(
				new Error('id : The value ws_123 is already present.'),
			)).toBe(true);
		});

		it('returns false for unrelated errors', () => {
			expect(isChargebeeDuplicateCustomerError(new Error('Network timeout'))).toBe(false);
			expect(isChargebeeDuplicateCustomerError('not-an-error')).toBe(false);
		});
	});
});
