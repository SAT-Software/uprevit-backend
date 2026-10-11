import { Db, ObjectId } from 'mongodb';
import type { Workspace } from '../models/workspace';
import { WORKFLOW_COUNTERS_COLLECTION, type WorkflowCounter } from '../models/workflowCounter';

const FALLBACK_PREFIX = 'WS';

/**
 * Derives the Workflow Prefix from a workspace name, e.g. "Acme Medical" → "AM", "Medtronic" → "MED".
 * @param {string} workspaceName Workspace name
 * @return {string} Two or three uppercase letters, or "WS" when the name has no usable letters
 */
export const deriveWorkflowPrefix = (workspaceName: string): string => {
	const words = workspaceName
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toUpperCase()
		.split(/[^A-Z]+/)
		.filter(Boolean);

	const prefix = words.length > 1
		? words.slice(0, 3).map((word) => word[0]).join('')
		: (words[0] ?? '').slice(0, 3);

	return prefix.length >= 2 ? prefix : FALLBACK_PREFIX;
};

export const formatWorkflowNumber = (prefix: string, number: number) =>
	`${prefix}-WF-${String(number).padStart(6, '0')}`;

/**
 * Parses a search term that refers to a Workflow Number: "AM-WF-000123", "WF-123", "000123" and "123" all give 123.
 * @param {string} search Search term
 * @return {number | null} The number, or null when the term is not a Workflow Number
 */
export const parseWorkflowNumberSearch = (search: string): number | null => {
	const match = search.trim().match(/^(?:[a-z]{1,3}-)?(?:wf-?)?(\d{1,9})$/i);
	return match ? Number(match[1]) : null;
};

/**
 * Returns the workspace's Workflow Prefix, saving it from the workspace name the first time.
 * @param {Db} db Database handle
 * @param {Workspace} workspace Workspace with `_id`, `workspaceName` and `workflowPrefix`
 * @return {Promise<string>} The saved prefix
 */
export const ensureWorkflowPrefix = async (db: Db, workspace: Pick<Workspace, '_id' | 'workspaceName' | 'workflowPrefix'>) => {
	if (workspace.workflowPrefix) return workspace.workflowPrefix;

	const workspaces = db.collection<Workspace>('workspaces');
	await workspaces.updateOne(
		{ _id: workspace._id, workflowPrefix: { $exists: false } },
		{ $set: { workflowPrefix: deriveWorkflowPrefix(workspace.workspaceName ?? '') } },
	);
	const saved = await workspaces.findOne({ _id: workspace._id }, { projection: { workflowPrefix: 1 } });
	return saved?.workflowPrefix ?? FALLBACK_PREFIX;
};

/**
 * Takes the next Workflow Number for a workspace. Numbers are never reused.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @return {Promise<number>} The next number, starting at 1
 */
export const nextWorkflowNumber = async (db: Db, workspaceId: ObjectId) => {
	const counter = await db.collection<WorkflowCounter>(WORKFLOW_COUNTERS_COLLECTION).findOneAndUpdate(
		{ workspaceId },
		{ $inc: { seq: 1 } },
		{ upsert: true, returnDocument: 'after' },
	);
	return counter!.seq;
};
