import { ObjectId } from 'mongodb';
import {
	SAVED_QUERY_COLLECTION,
	SAVED_QUERY_KINDS,
	type SavedQueryDefinition,
	type SavedQueryDocument,
	type SavedQueryKind,
} from '../models/savedQuery';
import type { QueryCondition } from '../types/reports';
import { validateConditions } from './reports/queryBuilder';
import { validateWorkflowQuery } from './workflowQuery';
import { getDb } from './db';

export const MAX_SAVED_QUERY_NAME_LENGTH = 120;
export const MAX_SAVED_QUERY_CONDITIONS = 10;
export const MAX_SAVED_QUERIES_PER_USER = 200;

let indexesPromise: Promise<unknown> | null = null;

export const getSavedQueriesCollection = async () => {
	const db = await getDb();
	const collection = db.collection<SavedQueryDocument>(SAVED_QUERY_COLLECTION);
	indexesPromise ??= Promise.all([
		collection.createIndex({ workspaceId: 1, kind: 1, updatedAt: -1 }),
		collection.createIndex({ workspaceId: 1, kind: 1, ownerUserId: 1 }),
	]).catch((error) => {
		indexesPromise = null;
		throw error;
	});
	await indexesPromise;
	return collection;
};

export const isSavedQueryKind = (value: unknown): value is SavedQueryKind =>
	typeof value === 'string' && SAVED_QUERY_KINDS.includes(value as SavedQueryKind);

const responseMessage = (response: { body: string }): string => {
	try {
		return (JSON.parse(response.body) as { message?: string }).message ?? 'Invalid query condition';
	} catch {
		return 'Invalid query condition';
	}
};

/**
 * Validates a stored definition with the same validator the matching query endpoint uses.
 * @param {SavedQueryKind} kind Which query engine the definition targets
 * @param {unknown} definition Definition from the request body
 * @return {string | null} The first problem, or null when the definition is valid
 */
export const validateSavedQueryDefinition = (kind: SavedQueryKind, definition: unknown): string | null => {
	if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
		return 'definition must be an object';
	}
	const { conditions, conditionLogic } = definition as { conditions?: unknown; conditionLogic?: unknown };
	if (!Array.isArray(conditions) || conditions.length === 0) return 'definition.conditions must be a non-empty array';
	if (conditions.length > MAX_SAVED_QUERY_CONDITIONS) return `Use at most ${MAX_SAVED_QUERY_CONDITIONS} conditions`;
	if (conditionLogic !== undefined && conditionLogic !== 'AND' && conditionLogic !== 'OR') {
		return 'definition.conditionLogic must be AND or OR';
	}
	if (kind === 'workflow') return validateWorkflowQuery(conditions);
	if (conditions.some((condition) => !condition || typeof condition !== 'object' || Array.isArray(condition))) {
		return 'Each condition must be an object';
	}
	const error = validateConditions(conditions as QueryCondition[]);
	return error ? responseMessage(error) : null;
};

export const toSavedQueryDefinition = (definition: unknown): SavedQueryDefinition => {
	const { conditions, conditionLogic } = definition as SavedQueryDefinition;
	return conditionLogic ? { conditions, conditionLogic } : { conditions };
};

export const normalizeSavedQueryName = (name: unknown): string | null => {
	if (typeof name !== 'string') return null;
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > MAX_SAVED_QUERY_NAME_LENGTH) return null;
	return trimmed;
};

export const parseJsonObject = (body: string | null): Record<string, unknown> | null => {
	if (!body) return null;
	try {
		const parsed: unknown = JSON.parse(body);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
};

export const toSavedQueryResponse = (query: SavedQueryDocument, callerUserId: ObjectId) => ({
	id: query._id.toString(),
	kind: query.kind,
	name: query.name,
	definition: query.definition,
	shared: query.shared,
	isOwner: query.ownerUserId.equals(callerUserId),
	createdAt: query.createdAt.toISOString(),
	updatedAt: query.updatedAt.toISOString(),
});

export const savedQueryListFilter = (workspaceId: ObjectId, kind: SavedQueryKind, callerUserId: ObjectId) => ({
	workspaceId,
	kind,
	$or: [{ ownerUserId: callerUserId }, { shared: true }],
});

export const savedQueryOwnerFilter = (queryId: ObjectId, workspaceId: ObjectId, callerUserId: ObjectId) => ({
	_id: queryId,
	workspaceId,
	ownerUserId: callerUserId,
});
