import { describe, expect, it, jest } from '@jest/globals';
import { isChargebeeDuplicateCustomerError, retrieveChargebeeCustomer } from '../../utils/billing/chargebeeClient';

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

	it('sends every request with a timeout signal', async () => {
		process.env.CHARGEBEE_SITE = 'test-site';
		process.env.CHARGEBEE_API_KEY = 'test-key';
		const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
		const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ customer: { id: 'cus_1' } }), { status: 200 }),
		);

		try {
			await retrieveChargebeeCustomer('cus_1');
			const init = fetchSpy.mock.calls[0][1] as RequestInit;
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(timeoutSpy).toHaveBeenCalledWith(10_000);
		} finally {
			fetchSpy.mockRestore();
			timeoutSpy.mockRestore();
			delete process.env.CHARGEBEE_SITE;
			delete process.env.CHARGEBEE_API_KEY;
		}
	});
});
