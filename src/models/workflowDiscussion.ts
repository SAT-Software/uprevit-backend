import { ObjectId } from 'mongodb';
import type { WorkflowActorSnapshot } from './workflow';

export const WORKFLOW_DISCUSSION_COLLECTION = 'workflowDiscussion';

export const WORKFLOW_DISCUSSION_KINDS = ['comment', 'change_request'] as const;
export type WorkflowDiscussionKind = typeof WORKFLOW_DISCUSSION_KINDS[number];

export type WorkflowDiscussionScope = { type: 'package' } | { type: 'product'; lineageId: ObjectId };

export type WorkflowDiscussionItem = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	workflowId: ObjectId;
	kind: WorkflowDiscussionKind;
	scope: WorkflowDiscussionScope;
	authorSnapshot: WorkflowActorSnapshot;
	body: string;
	createdAt: Date;
	assignmentId?: ObjectId;
	status?: 'open' | 'addressed';
	addressedBySnapshot?: WorkflowActorSnapshot;
	addressNote?: string;
	addressedAt?: Date;
};
