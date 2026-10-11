import { ObjectId } from 'mongodb';

export const WORKFLOW_COUNTERS_COLLECTION = 'workflowCounters';

export type WorkflowCounter = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	seq: number;
};
