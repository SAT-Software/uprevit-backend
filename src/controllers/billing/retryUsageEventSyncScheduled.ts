import { ScheduledEvent } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { processScheduledUsageEventRetries } from '../../utils/billing/usageEventChargebeeSync';

/**
 * Scheduled job that retries failed Chargebee usage event syncs within the 12-hour window.
 * @param {ScheduledEvent} _event EventBridge scheduled event
 * @return {Promise<void>}
 */
export const lambdaHandler = async (_event: ScheduledEvent): Promise<void> => {
	try {
		const result = await processScheduledUsageEventRetries();
		console.log(JSON.stringify({
			message: 'Chargebee usage event retry job completed',
			...result,
		}));
	} catch (error) {
		logError('Scheduled Chargebee usage event retry failed', error);
		throw error;
	}
};
