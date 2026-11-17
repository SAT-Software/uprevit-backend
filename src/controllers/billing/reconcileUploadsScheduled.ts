import { ScheduledEvent } from 'aws-lambda';
import { logError } from '../../utils/logger';
import { reconcileExpiredUploadGrants } from '../../utils/billing/uploadCommit';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Scheduled job that meters expired upload grants against stored object sizes.
 * @param {ScheduledEvent} _event EventBridge scheduled event
 * @return {Promise<void>}
 */
export const lambdaHandler = withTelemetry(async (_event: ScheduledEvent): Promise<void> => {
	try {
		const result = await reconcileExpiredUploadGrants();
		console.log(JSON.stringify({ message: 'Upload grant reconciliation completed', ...result }));
	} catch (error) {
		logError('Scheduled upload grant reconciliation failed', error);
		throw error;
	}
});
