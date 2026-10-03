import { ObjectId } from 'mongodb';

export const WORKFLOWS_COLLECTION = 'workflows';

export const WORKFLOW_STATUSES = ['draft', 'in_review', 'ready_to_complete', 'completed', 'rejected', 'cancelled'] as const;
export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];

/** Started workflows that still hold their Products. */
export const ACTIVE_WORKFLOW_STATUSES: WorkflowStatus[] = ['in_review', 'ready_to_complete'];

export const WORKFLOW_COMPLETION_MODES = ['automatic', 'initiator_controlled'] as const;
export type WorkflowCompletionMode = typeof WORKFLOW_COMPLETION_MODES[number];

export type WorkflowUserSnapshot = {
	name: string;
	email: string;
};

export type WorkflowProduct = {
	lineageId: ObjectId;
	productVersionId: ObjectId;
	name: string;
	planNumber: string;
	version: number;
};

export type WorkflowRelationship = 'product_owner' | 'product_contributor';

export type WorkflowAssignment = {
	_id: ObjectId;
	functionType: 'product_team' | 'function';
	functionLabel: string;
	lineageId?: ObjectId;
	userId: ObjectId;
	userSnapshot: WorkflowUserSnapshot;
	relationship?: WorkflowRelationship;
	decision: 'pending';
};

export type Workflow = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	number: number;
	numberLabel: string;
	name: string;
	description: string;
	status: WorkflowStatus;
	completionMode: WorkflowCompletionMode;
	initiator: WorkflowUserSnapshot & { userId: ObjectId };
	products: WorkflowProduct[];
	assignments: WorkflowAssignment[];
	dates: {
		createdAt: Date;
	};
};
