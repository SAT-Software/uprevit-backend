import { ScheduledEvent } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { processScheduledUsageEventRetries } from '../../utils/billing/usageEventChargebeeSync';
import { withTelemetry } from '../../utils/telemetry';

const { BETTER_STACK_HEARTBEAT_URL } = process.env;

/**
 * Reports the job outcome to the Better Stack heartbeat, when configured.
 * @param {boolean} succeeded Whether the job run completed
 * @return {Promise<void>}
 */
const sendHeartbeat = async (succeeded: boolean): Promise<void> => {
	if (!BETTER_STACK_HEARTBEAT_URL) return;
	try {
		await fetch(succeeded ? BETTER_STACK_HEARTBEAT_URL : `${BETTER_STACK_HEARTBEAT_URL}/fail`, {
			signal: AbortSignal.timeout(5000),
		});
	} catch (error) {
		logError('Better Stack heartbeat failed', error);
	}
};

/**
 * Scheduled job that retries failed Chargebee usage event syncs within the 12-hour window.
 * @param {ScheduledEvent} _event EventBridge scheduled event
 * @return {Promise<void>}
 */
export const lambdaHandler = withTelemetry(async (_event: ScheduledEvent): Promise<void> => {
	try {
		const result = await processScheduledUsageEventRetries();
		console.log(JSON.stringify({
			message: 'Chargebee usage event retry job completed',
			...result,
		}));
		await sendHeartbeat(true);
	} catch (error) {
		logError('Scheduled Chargebee usage event retry failed', error);
		await sendHeartbeat(false);
		throw error;
	}
});
