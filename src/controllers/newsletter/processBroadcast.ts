import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { logError, logInfo, logWarn } from '../../utils/logger';
import { getSubscriber, incrementBroadcastCounter } from '../../utils/newsletter/db';
import { type BlogPostEmailPayload, renderBlogPostEmail, sendNewsletterEmail } from '../../utils/newsletter/emails';
import {
	getNewsletterFromAddress,
	getNewsletterPhysicalAddress,
	getNewsletterReplyToAddress,
	getNewsletterSiteBaseUrl,
} from '../../utils/newsletter/request';
import { createUnsubscribeToken, getNewsletterTokenSecret } from '../../utils/newsletter/tokens';
import { withTelemetry } from '../../utils/telemetry';

export interface BroadcastQueueMessage {
	slug: string;
	email: string;
	apiBaseUrl?: string;
	siteBaseUrl?: string;
	post: BlogPostEmailPayload;
}

export const lambdaHandler = withTelemetry(async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const batchItemFailures: SQSBatchItemFailure[] = [];
	const secret = await getNewsletterTokenSecret();
	if (!secret) {
		logError('Newsletter token secret is not configured for broadcast worker', new Error('Missing newsletter token secret'));
		return {
			batchItemFailures: event.Records.map((record) => ({ itemIdentifier: record.messageId })),
		};
	}

	const from = getNewsletterFromAddress();
	const replyTo = getNewsletterReplyToAddress();
	const physicalAddress = getNewsletterPhysicalAddress();
	const configurationSetName = process.env.NEWSLETTER_CONFIGURATION_SET;
	const defaultSiteBaseUrl = getNewsletterSiteBaseUrl();
	const defaultApiBaseUrl = process.env.NEWSLETTER_API_BASE_URL?.trim().replace(/\/+$/, '') ?? '';

	for (const record of event.Records) {
		let message: BroadcastQueueMessage;
		try {
			message = JSON.parse(record.body) as BroadcastQueueMessage;
		} catch (error) {
			logWarn('Discarding malformed newsletter broadcast SQS message', { messageId: record.messageId });
			continue;
		}

		const email = message.email?.trim().toLowerCase();
		if (!email || !message.slug || !message.post?.title || !message.post?.url) {
			logWarn('Discarding incomplete newsletter broadcast SQS message', { messageId: record.messageId });
			continue;
		}

		try {
			const subscriber = await getSubscriber(email);
			if (!subscriber || subscriber.status !== 'subscribed') {
				logInfo('Skipping broadcast recipient because subscriber is no longer active', {
					slug: message.slug,
					status: subscriber?.status ?? 'missing',
				});
				continue;
			}

			const siteBaseUrl = (message.siteBaseUrl?.trim() || defaultSiteBaseUrl).replace(/\/+$/, '');
			const apiBaseUrl = (message.apiBaseUrl?.trim() || defaultApiBaseUrl).replace(/\/+$/, '');
			const unsubscribeToken = createUnsubscribeToken(email, secret);
			const encodedToken = encodeURIComponent(unsubscribeToken);
			const unsubscribeUrl = `${siteBaseUrl}/newsletter/unsubscribe?token=${encodedToken}`;
			const oneClickUnsubscribeUrl = apiBaseUrl ? `${apiBaseUrl}/newsletter/unsubscribe?token=${encodedToken}` : undefined;

			const rendered = renderBlogPostEmail({
				post: message.post,
				unsubscribeUrl,
				siteBaseUrl,
				physicalAddress,
			});

			await sendNewsletterEmail({
				to: email,
				from,
				replyTo,
				configurationSetName,
				email: rendered,
				oneClickUnsubscribeUrl,
			});

			await incrementBroadcastCounter(message.slug, 'sentCount').catch(() => undefined);
		} catch (error) {
			logError('Failed to send newsletter broadcast email', error, { slug: message.slug, messageId: record.messageId });
			await incrementBroadcastCounter(message.slug, 'failedCount').catch(() => undefined);
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	}

	return { batchItemFailures };
});
