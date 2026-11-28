import type { SNSEvent } from 'aws-lambda';
import { logError, logInfo, logWarn } from '../../utils/logger';
import { suppressSubscriber } from '../../utils/newsletter/db';
import { withTelemetry } from '../../utils/telemetry';

interface SesBounceRecipient {
	emailAddress?: string;
	diagnosticCode?: string;
}

interface SesComplaintRecipient {
	emailAddress?: string;
}

interface SesFeedbackNotification {
	eventType?: string;
	notificationType?: string;
	bounce?: {
		bounceType?: string;
		bounceSubType?: string;
		bouncedRecipients?: SesBounceRecipient[];
	};
	complaint?: {
		complaintFeedbackType?: string;
		complainedRecipients?: SesComplaintRecipient[];
	};
}

const emitMetric = (metricName: string, count: number): void => {
	const stack = process.env.MONITORING_STACK?.trim();
	if (!stack || count <= 0) return;
	console.log(
		JSON.stringify({
			_aws: {
				Timestamp: Date.now(),
				CloudWatchMetrics: [
					{
						Namespace: 'Uprevit',
						Dimensions: [['Stack']],
						Metrics: [{ Name: metricName, Unit: 'Count' }],
					},
				],
			},
			Stack: stack,
			[metricName]: count,
		}),
	);
};

export const lambdaHandler = withTelemetry(async (event: SNSEvent): Promise<void> => {
	const nowIso = new Date().toISOString();
	const failedUpdates: string[] = [];

	for (const record of event.Records) {
		let payload: SesFeedbackNotification;
		try {
			payload = JSON.parse(record.Sns.Message) as SesFeedbackNotification;
		} catch (error) {
			logWarn('Ignoring non-JSON SES feedback SNS message', { messageId: record.Sns.MessageId });
			continue;
		}

		const kind = (payload.eventType ?? payload.notificationType ?? '').toLowerCase();

		if (kind === 'bounce' && payload.bounce) {
			const bounceType = payload.bounce.bounceType ?? 'Unknown';
			if (bounceType !== 'Permanent') {
				logInfo('Ignoring non-permanent SES bounce', { bounceType, bounceSubType: payload.bounce.bounceSubType });
				continue;
			}

			const recipients = payload.bounce.bouncedRecipients ?? [];
			let suppressedCount = 0;
			for (const recipient of recipients) {
				const email = recipient.emailAddress?.trim().toLowerCase();
				if (!email) continue;
				const reason = [bounceType, payload.bounce.bounceSubType, recipient.diagnosticCode].filter(Boolean).join(': ').slice(0, 240);
				try {
					await suppressSubscriber({ email, status: 'bounced', reason: reason || 'Permanent bounce', nowIso });
					suppressedCount += 1;
				} catch (error) {
					logError('Failed to suppress bounced newsletter subscriber', error, { bounceType });
					failedUpdates.push(`bounce:${record.Sns.MessageId}`);
				}
			}
			emitMetric('NewsletterBounce', suppressedCount);
		} else if (kind === 'complaint' && payload.complaint) {
			const recipients = payload.complaint.complainedRecipients ?? [];
			let suppressedCount = 0;
			for (const recipient of recipients) {
				const email = recipient.emailAddress?.trim().toLowerCase();
				if (!email) continue;
				const reason = payload.complaint.complaintFeedbackType || 'Spam complaint';
				try {
					await suppressSubscriber({ email, status: 'complained', reason, nowIso });
					suppressedCount += 1;
				} catch (error) {
					logError('Failed to suppress complained newsletter subscriber', error);
					failedUpdates.push(`complaint:${record.Sns.MessageId}`);
				}
			}
			emitMetric('NewsletterComplaint', suppressedCount);
		}
	}

	if (failedUpdates.length > 0) {
		throw new Error(`Failed to persist ${failedUpdates.length} SES feedback suppression update(s).`);
	}
});
