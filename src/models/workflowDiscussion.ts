import { ObjectId } from 'mongodb';
import type { WorkflowActorSnapshot } from './workflow';

export const WORKFLOW_DISCUSSION_COLLECTION = 'workflowDiscussion';

export const WORKFLOW_DISCUSSION_KINDS = ['comment', 'change_request'] as const;
export type WorkflowDiscussionKind = typeof WORKFLOW_DISCUSSION_KINDS[number];

export type WorkflowDiscussionScope = { type: 'package' } | { type: 'product'; lineageId: ObjectId };

export const WORKFLOW_ATTACHMENT_LIMIT = 4;
export const WORKFLOW_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const WORKFLOW_ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export type WorkflowDiscussionAttachment = {
	key: string;
	fileName: string;
	contentType: string;
	sizeBytes: number;
};

export type WorkflowDiscussionItem = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	workflowId: ObjectId;
	kind: WorkflowDiscussionKind;
	scope: WorkflowDiscussionScope;
	authorSnapshot: WorkflowActorSnapshot;
	body: string;
	attachments?: WorkflowDiscussionAttachment[];
	createdAt: Date;
	assignmentId?: ObjectId;
	status?: 'open' | 'addressed';
	addressedBySnapshot?: WorkflowActorSnapshot;
	addressNote?: string;
	addressedAt?: Date;
};
