import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import crypto from 'node:crypto';
import { getDb } from '../../utils/db';
import {
	SUPPORT_ATTACHMENT_COLLECTION,
	SUPPORT_ATTACHMENT_CONTENT_TYPES,
	SUPPORT_ATTACHMENT_MAX_BYTES,
	type SupportAttachment,
	type SupportAttachmentContentType,
} from '../../models/supportAttachment';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import {
	createSupportAttachmentUpload,
	ensureSupportAttachmentIndexes,
	reserveSupportAttachmentUpload,
	supportAttachmentKey,
} from '../../utils/supportAttachments';
import { withTelemetry } from '../../utils/telemetry';

const HOURLY_UPLOAD_LIMIT = 40;

const isSupportedContentType = (value: unknown): value is SupportAttachmentContentType =>
	typeof value === 'string' && (SUPPORT_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);

/**
 * Creates a pending support screenshot and returns a short-lived S3 POST policy for it.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		let input: unknown;
		try {
			input = JSON.parse(event.body ?? '');
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}
		if (typeof input !== 'object' || input === null || Array.isArray(input)) {
			return ResponseWrapper.badRequest('Request body must be a JSON object');
		}

		const { contentType, sizeBytes } = input as { contentType?: unknown; sizeBytes?: unknown };
		if (!isSupportedContentType(contentType)) {
			return ResponseWrapper.badRequest('Screenshots must be PNG, JPEG, GIF or WebP images.');
		}
		if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > SUPPORT_ATTACHMENT_MAX_BYTES) {
			return ResponseWrapper.badRequest('Each screenshot must be 5 MB or smaller.');
		}

		await ensureSupportAttachmentIndexes();
		if (!(await reserveSupportAttachmentUpload(context.userId, HOURLY_UPLOAD_LIMIT))) {
			return ResponseWrapper.custom(429, { message: 'Too many screenshots uploaded. Please try again later.' });
		}

		const attachmentId = crypto.randomUUID();
		const key = supportAttachmentKey(attachmentId);

		const db = await getDb();
		await db.collection<SupportAttachment>(SUPPORT_ATTACHMENT_COLLECTION).insertOne({
			attachmentId,
			key,
			workspaceId: context.workspaceId,
			userId: context.userId,
			cognitoSub: context.cognitoSub,
			contentType,
			sizeBytes,
			ready: false,
			createdAt: new Date(),
		});

		const upload = await createSupportAttachmentUpload(key, contentType, sizeBytes);

		return ResponseWrapper.created({
			message: 'Support screenshot upload created',
			result: { id: attachmentId, upload },
		});
	} catch (err) {
		logError('Create support attachment handler failed', err);
		return ResponseWrapper.internalServerError('Failed to prepare screenshot upload');
	}
});
