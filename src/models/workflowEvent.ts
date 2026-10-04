import { ObjectId } from 'mongodb';
import type { WorkflowActorSnapshot } from './workflow';

export const WORKFLOW_EVENTS_COLLECTION = 'workflowEvents';

export type WorkflowEventType =
	| 'started'
	| 'approved'
	| 'approval_reconfirmed'
	| 'content_changed'
	| 'changes_requested'
	| 'change_request_addressed'
	| 'ready_to_complete'
	| 'completed'
	| 'rejected'
	| 'cancelled';

/** Append-only workflow history record. Never updated or deleted. */
export type WorkflowEvent = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	workflowId: ObjectId;
	type: WorkflowEventType;
	actorSnapshot: WorkflowActorSnapshot;
	assignmentId?: ObjectId;
	lineageId?: ObjectId;
	reason?: string;
	comment?: string;
	data: Record<string, unknown>;
	createdAt: Date;
};
