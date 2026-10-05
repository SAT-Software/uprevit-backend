import type { Document } from 'mongodb';
import type { ConditionLogic } from '../types/reports';
import { WORKFLOW_COMPLETION_MODES, WORKFLOW_STATUSES } from '../models/workflow';
import { combineConditionQueries } from './reports/queryBuilder';
import { parseWorkflowNumberSearch } from './workflowNumber';

export const MAX_WORKFLOW_QUERY_CONDITIONS = 10;

const TEXT_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains'] as const;
const OPTION_OPERATORS = ['equals', 'not_equals'] as const;
const DATE_OPERATORS = ['on', 'before', 'after', 'exists', 'not_exists'] as const;

type FieldConfig =
	| { type: 'text'; paths: string[]; arrayPath?: string }
	| { type: 'option'; path: string; options: readonly string[] }
	| { type: 'date'; path: string };

const WORKFLOW_QUERY_FIELDS: Record<string, FieldConfig> = {
	number: { type: 'text', paths: ['numberLabel'] },
	name: { type: 'text', paths: ['name'] },
	status: { type: 'option', path: 'status', options: WORKFLOW_STATUSES },
	product: { type: 'text', arrayPath: 'products', paths: ['name', 'planNumber'] },
	initiator: { type: 'text', paths: ['initiator.name', 'initiator.email'] },
	approver: { type: 'text', arrayPath: 'assignments', paths: ['userSnapshot.name', 'userSnapshot.email'] },
	function: { type: 'text', arrayPath: 'assignments', paths: ['functionLabel'] },
	completionMode: { type: 'option', path: 'completionMode', options: WORKFLOW_COMPLETION_MODES },
	createdAt: { type: 'date', path: 'dates.createdAt' },
	startedAt: { type: 'date', path: 'dates.startedAt' },
	readyToCompleteAt: { type: 'date', path: 'dates.readyToCompleteAt' },
	completedAt: { type: 'date', path: 'dates.completedAt' },
	rejectedAt: { type: 'date', path: 'dates.rejectedAt' },
	cancelledAt: { type: 'date', path: 'dates.cancelledAt' },
};

export type WorkflowQueryCondition = {
	field: string;
	operator: string;
	value?: string;
	logic?: ConditionLogic;
};

const MAX_DAY_MS = 25 * 60 * 60 * 1000;

/**
 * Parses a local calendar day sent as `start/end` ISO instants, so days with a daylight-saving change keep their real length.
 * @param {string} value Interval such as `2026-03-08T05:00:00.000Z/2026-03-09T04:00:00.000Z`
 * @return {[Date, Date] | null} Start and end, or null when the interval is not a single day
 */
const parseDayInterval = (value: string): [Date, Date] | null => {
	const [start, end, extra] = value.split('/').map((part) => new Date(part));
	if (!start || !end || extra || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
	const length = end.getTime() - start.getTime();
	return length > 0 && length <= MAX_DAY_MS ? [start, end] : null;
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const operatorsFor = (field: FieldConfig): readonly string[] =>
	field.type === 'text' ? TEXT_OPERATORS : field.type === 'option' ? OPTION_OPERATORS : DATE_OPERATORS;

/**
 * Validates advanced search conditions. Date values are the searcher's local day as an ISO interval, `start/end`.
 * @param {unknown} conditions Conditions from the request body
 * @return {string | null} The first problem, or null when every condition is valid
 */
export const validateWorkflowQuery = (conditions: unknown): string | null => {
	if (!Array.isArray(conditions) || conditions.length === 0) return 'Add at least one condition';
	if (conditions.length > MAX_WORKFLOW_QUERY_CONDITIONS) return `Use at most ${MAX_WORKFLOW_QUERY_CONDITIONS} conditions`;

	for (const condition of conditions as WorkflowQueryCondition[]) {
		if (typeof condition !== 'object' || condition === null || typeof condition.field !== 'string' || typeof condition.operator !== 'string') {
			return 'Each condition needs a field and an operator';
		}
		if (!Object.prototype.hasOwnProperty.call(WORKFLOW_QUERY_FIELDS, condition.field)) return `Unknown field: ${condition.field}`;
		const field = WORKFLOW_QUERY_FIELDS[condition.field];
		if (!operatorsFor(field).includes(condition.operator)) return `Operator ${condition.operator} is not supported for ${condition.field}`;
		if (condition.logic !== undefined && condition.logic !== 'AND' && condition.logic !== 'OR') return 'logic must be AND or OR';
		if (condition.operator === 'exists' || condition.operator === 'not_exists') continue;
		if (typeof condition.value !== 'string' || !condition.value.trim()) return `Enter a value for ${condition.field}`;
		if (field.type === 'option' && !field.options.includes(condition.value)) return `Invalid value for ${condition.field}`;
		if (field.type === 'date' && !parseDayInterval(condition.value)) return `Invalid date for ${condition.field}`;
	}
	return null;
};

const buildTextMatch = (field: Extract<FieldConfig, { type: 'text' }>, condition: WorkflowQueryCondition): Document => {
	const value = condition.value!.trim();
	const exact = condition.operator === 'equals' || condition.operator === 'not_equals';
	const regex = { $regex: exact ? `^${escapeRegex(value)}$` : escapeRegex(value), $options: 'i' };
	const anyPath: Document[] = field.paths.map((path) => ({ [path]: regex }));
	const number = field.paths[0] === 'numberLabel' && exact ? parseWorkflowNumberSearch(value) : null;
	if (number !== null) anyPath.push({ number });

	const match = field.arrayPath ? { [field.arrayPath]: { $elemMatch: { $or: anyPath } } } : { $or: anyPath };
	return condition.operator.startsWith('not_') ? { $nor: [match] } : match;
};

const buildDateMatch = (path: string, condition: WorkflowQueryCondition): Document => {
	if (condition.operator === 'exists') return { [path]: { $ne: null } };
	if (condition.operator === 'not_exists') return { [path]: null };

	const [dayStart, nextDay] = parseDayInterval(condition.value!)!;
	if (condition.operator === 'before') return { [path]: { $lt: dayStart } };
	if (condition.operator === 'after') return { [path]: { $gte: nextDay } };
	return { [path]: { $gte: dayStart, $lt: nextDay } };
};

/**
 * Builds the MongoDB filter for validated advanced search conditions, chained left to right with each condition's logic.
 * @param {WorkflowQueryCondition[]} conditions Conditions accepted by `validateWorkflowQuery`
 * @return {Document} Filter for the workflows collection
 */
export const buildWorkflowQueryMatch = (conditions: WorkflowQueryCondition[]): Document => {
	const matches = conditions.map((condition) => {
		const field = WORKFLOW_QUERY_FIELDS[condition.field];
		if (field.type === 'text') return buildTextMatch(field, condition);
		if (field.type === 'date') return buildDateMatch(field.path, condition);
		return { [field.path]: condition.operator === 'equals' ? condition.value : { $ne: condition.value } };
	});
	return combineConditionQueries(conditions.map((condition, index) => ({ logic: index === 0 ? undefined : condition.logic ?? 'AND' })), matches);
};
