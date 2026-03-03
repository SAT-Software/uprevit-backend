import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { ExportQueueMessage } from '../types/export-job';

const queueUrl = process.env.EXPORT_JOB_QUEUE_URL;

if (!queueUrl) {
	throw new Error('Missing required environment variable: EXPORT_JOB_QUEUE_URL');
}

const sqsClient = new SQSClient({});

/**
 * Sends an export job message to the configured SQS queue.
 * @param {ExportQueueMessage} payload - Export job queue payload
 * @return {Promise<void>} Resolves when message is accepted by SQS
 */
export const enqueueExportJobMessage = async (payload: ExportQueueMessage): Promise<void> => {
	await sqsClient.send(
		new SendMessageCommand({
			QueueUrl: queueUrl,
			MessageBody: JSON.stringify(payload),
			MessageAttributes: {
				target: {
					DataType: 'String',
					StringValue: payload.target,
				},
				format: {
					DataType: 'String',
					StringValue: payload.format,
				},
			},
		}),
	);
};
