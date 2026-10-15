import { ObjectId } from 'mongodb';

export const SUPPORT_ATTACHMENT_COLLECTION = 'supportAttachments';

export const SUPPORT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type SupportAttachmentContentType = typeof SUPPORT_ATTACHMENT_CONTENT_TYPES[number];

export type SupportAttachment = {
	_id?: ObjectId;
	attachmentId: string;
	key: string;
	workspaceId: ObjectId;
	userId: ObjectId;
	cognitoSub: string;
	contentType: SupportAttachmentContentType;
	sizeBytes: number;
	ready: boolean;
	versionId?: string;
	createdAt: Date;
	readyAt?: Date;
};

export const SUPPORT_ATTACHMENT_QUOTA_COLLECTION = 'supportAttachmentQuotas';

export type SupportAttachmentQuota = {
	_id?: ObjectId;
	userId: ObjectId;
	uploads: number[];
};
