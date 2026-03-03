import { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logError, logInfo } from '../../utils/logger';

/**
 * Phase 2 worker scaffold.
 * Real processing flow will be implemented in the next phase.
 * @param {SQSEvent} event - SQS event payload
 * @return {Promise<SQSBatchResponse>} Batch item failure response
 */
export const lambdaHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

	for (const record of event.Records) {
		try {
			logInfo('Received export job message', {
				messageId: record.messageId,
				receiptHandle: record.receiptHandle,
			});
		} catch (error) {
			logError('Failed to process export job message', error, {
				messageId: record.messageId,
			});
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	}

	return { batchItemFailures };
};
