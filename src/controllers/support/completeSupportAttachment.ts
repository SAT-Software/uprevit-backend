import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SUPPORT_ATTACHMENT_COLLECTION, type SupportAttachment } from '../../models/supportAttachment';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { SUPPORT_ATTACHMENT_ID_PATTERN, verifySupportAttachmentObject } from '../../utils/supportAttachments';

/**
 * Verifies the caller's uploaded support screenshot and marks it ready to be linked from a ticket.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const attachmentId = event.pathParameters?.id ?? '';
		if (!SUPPORT_ATTACHMENT_ID_PATTERN.test(attachmentId)) {
			return ResponseWrapper.notFound('Screenshot not found');
		}

		const db = await getDb();
		const collection = db.collection<SupportAttachment>(SUPPORT_ATTACHMENT_COLLECTION);
		const ownerFilter = { attachmentId, userId: context.userId, workspaceId: context.workspaceId };
		const attachment = await collection.findOne(ownerFilter);

		if (!attachment) {
			return ResponseWrapper.notFound('Screenshot not found');
		}

		if (!attachment.ready) {
			const versionId = await verifySupportAttachmentObject(attachment.key, attachment.contentType, attachment.sizeBytes);
			if (!versionId) {
				return ResponseWrapper.badRequest('The screenshot upload could not be verified. Please upload it again.');
			}

			await collection.updateOne(
				{ ...ownerFilter, ready: false },
				{ $set: { ready: true, versionId, readyAt: new Date() } },
			);
		}

		return ResponseWrapper.success({
			message: 'Support screenshot ready',
			result: { id: attachmentId },
		});
	} catch (err) {
		logError('Complete support attachment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to verify screenshot');
	}
};
