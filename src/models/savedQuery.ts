import { ObjectId } from 'mongodb';
import type { ConditionLogic } from '../types/reports';

export const SAVED_QUERY_COLLECTION = 'savedQueries';
export const SAVED_QUERY_KINDS = ['report', 'workflow'] as const;
export type SavedQueryKind = typeof SAVED_QUERY_KINDS[number];

export type SavedQueryDefinition = {
	conditions: Array<Record<string, unknown>>;
	conditionLogic?: ConditionLogic;
};

export type SavedQuery = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	ownerUserId: ObjectId;
	kind: SavedQueryKind;
	name: string;
	definition: SavedQueryDefinition;
	shared: boolean;
	createdAt: Date;
	updatedAt: Date;
};

export type SavedQueryDocument = SavedQuery & { _id: ObjectId };
