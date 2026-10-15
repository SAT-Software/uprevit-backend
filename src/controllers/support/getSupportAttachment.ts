import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SUPPORT_ATTACHMENT_COLLECTION, type SupportAttachment } from '../../models/supportAttachment';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireSupportReviewer } from '../../utils/support';
import {
	SUPPORT_ATTACHMENT_ID_PATTERN,
	SUPPORT_ATTACHMENT_VIEW_EXPIRES_IN_SECONDS,
	createSupportAttachmentViewUrl,
	ensureSupportAttachmentIndexes,
} from '../../utils/supportAttachments';

/**
 * Returns a short-lived view URL for a support screenshot to an allowlisted Uprevit support reviewer.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const reviewer = await requireSupportReviewer(event);
		if (!reviewer.ok) return reviewer.response;

		const attachmentId = event.pathParameters?.id ?? '';
		if (!SUPPORT_ATTACHMENT_ID_PATTERN.test(attachmentId)) {
			return ResponseWrapper.notFound('Screenshot not found');
		}

		await ensureSupportAttachmentIndexes();
		const db = await getDb();
		const attachment = await db.collection<SupportAttachment>(SUPPORT_ATTACHMENT_COLLECTION).findOne(
			{ attachmentId, ready: true },
			{ projection: { key: 1, versionId: 1, contentType: 1, sizeBytes: 1, readyAt: 1 } },
		);

		if (!attachment?.versionId) {
			return ResponseWrapper.notFound('Screenshot not found');
		}

		const url = await createSupportAttachmentViewUrl(attachment.key, attachment.versionId, attachment.contentType);

		return {
			...ResponseWrapper.success({
				message: 'Support screenshot retrieved successfully',
				result: {
					url,
					contentType: attachment.contentType,
					sizeBytes: attachment.sizeBytes,
					uploadedAt: attachment.readyAt,
					expiresAt: new Date(Date.now() + SUPPORT_ATTACHMENT_VIEW_EXPIRES_IN_SECONDS * 1000).toISOString(),
				},
			}),
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
		};
	} catch (err) {
		logError('Get support attachment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get screenshot');
	}
};
