import { COMPLETION_TABS } from '../productLifecycle';
import { ObjectId, Document } from 'mongodb';
import {
	QueryCondition,
	QueryOperator,
	ConditionLogic,
	REPORT_SECTIONS,
	REPORT_OPERATORS,
	ReportField,
	ReportSection,
	NO_VALUE_OPERATORS,
	ARRAY_OPERATORS,
	ReportsQueryRequest,
	ReportsExportRequest,
	ALLOWED_SORT_FIELDS,
} from '../../types/reports';
import { ResponseWrapper } from '../responseWrapper';
import { escapeRegex } from '../regex';
import { parseDayInterval } from '../dayInterval';
import { APIGatewayProxyResult } from 'aws-lambda';

const hasOwn = (object: object, key: unknown) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

const getField = (condition: QueryCondition): { section: ReportSection; field: ReportField } | null => {
	if (!hasOwn(REPORT_SECTIONS, condition.tab)) return null;
	const section = REPORT_SECTIONS[condition.tab];
	return hasOwn(section.fields, condition.field) ? { section, field: section.fields[condition.field] } : null;
};

const isValidValue = (field: ReportField, operator: QueryOperator, value: unknown): boolean => {
	if (ARRAY_OPERATORS.includes(operator)) {
		return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
	}
	if (typeof value !== 'string' || !value.trim()) return false;
	switch (field.type) {
	case 'option':
	case 'tab':
		return field.options!.includes(value);
	case 'boolean':
	case 'presence':
		return value === 'true' || value === 'false';
	case 'number':
		return Number.isFinite(Number(value));
	case 'count':
		return Number.isInteger(Number(value)) && Number(value) >= 0;
	case 'date':
		return Boolean(parseDayInterval(value));
	default:
		return true;
	}
};

export function validateCondition(condition: QueryCondition): APIGatewayProxyResult | null {
	const resolved = getField(condition);
	if (!resolved) return ResponseWrapper.badRequest(`Unknown field '${condition.field}' in '${condition.tab}'`);

	if (!REPORT_OPERATORS[resolved.field.type].includes(condition.operator)) {
		return ResponseWrapper.badRequest(`Operator '${condition.operator}' is not supported for '${condition.field}'`);
	}

	if (!NO_VALUE_OPERATORS.includes(condition.operator) && !isValidValue(resolved.field, condition.operator, condition.value)) {
		return ResponseWrapper.badRequest(`Enter a valid value for '${condition.field}'`);
	}

	return null;
}

export function validateConditions(conditions: QueryCondition[]): APIGatewayProxyResult | null {
	for (const condition of conditions) {
		const error = validateCondition(condition);
		if (error) return error;

		if (condition.logic && !['AND', 'OR'].includes(condition.logic)) {
			return ResponseWrapper.badRequest(
				`"condition.logic" must be either "AND" or "OR". Found: "${condition.logic}" for field "${condition.field}"`,
			);
		}
	}
	return null;
}

const NEGATED: Partial<Record<QueryOperator, QueryOperator>> = {
	not_equals: 'equals',
	not_contains: 'contains',
	not_exists: 'exists',
};

const COMPARE: Partial<Record<QueryOperator, string>> = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };

const exactRegex = (value: string) => new RegExp(`^${escapeRegex(value.trim())}$`, 'i');
const containsRegex = (value: string) => new RegExp(escapeRegex(value.trim()), 'i');
const negate = (match: Document): Document => ({ $nor: [match] });

function buildDateMatch(path: string, operator: QueryOperator, value?: string | string[]): Document {
	const date = { $convert: { input: `$${path}`, to: 'date', onError: null, onNull: null } };
	if (operator === 'exists') return { $expr: { $ne: [date, null] } };
	if (operator === 'not_exists') return { $expr: { $eq: [date, null] } };

	const [dayStart, nextDay] = parseDayInterval(value as string)!;
	if (operator === 'before') return { $expr: { $and: [{ $ne: [date, null] }, { $lt: [date, dayStart] }] } };
	if (operator === 'after') return { $expr: { $gte: [date, nextDay] } };
	return { $expr: { $and: [{ $gte: [date, dayStart] }, { $lt: [date, nextDay] }] } };
}

function buildCountMatch(section: ReportSection, operator: QueryOperator, value?: string | string[]): Document {
	const items = { $ifNull: [`$${section.path}`, []] };
	const matching = section.entities
		? { $filter: { input: items, as: 'item', cond: { $in: ['$$item.entity', section.entities] } } }
		: items;
	const mongoOperator = COMPARE[operator] ?? (operator === 'equals' ? '$eq' : '$ne');
	return { $expr: { [mongoOperator]: [{ $size: matching }, Number(value)] } };
}

/**
 * Builds the positive match for one field, at its path on the product or on an array item.
 * @param {string} path Field path
 * @param {ReportField} field Field config
 * @param {QueryOperator} operator Operator without negation
 * @param {string | string[]} value Condition value
 * @return {Document} Match
 */
function buildFieldMatch(path: string, field: ReportField, operator: QueryOperator, value?: string | string[]): Document {
	const text = typeof value === 'string' ? value : '';

	if (field.type === 'person') {
		if (operator === 'exists') return { [`${path}.0`]: { $exists: true } };
		const regex = operator === 'equals' ? exactRegex(text) : containsRegex(text);
		return { [path]: { $elemMatch: { $or: [{ name: regex }, { email: regex }] } } };
	}
	if (field.type === 'boolean') return { [path]: text === 'true' ? true : { $ne: true } };
	if (field.type === 'presence') {
		const present = { [path]: { $exists: true, $ne: null } };
		return text === 'true' ? present : negate(present);
	}
	if (field.type === 'tab') return { [`${text}.tab_completed`]: true };
	if (field.type === 'number') {
		if (operator === 'exists') return { [path]: { $type: 'number' } };
		const compare = COMPARE[operator];
		return { [path]: compare ? { [compare]: Number(text) } : Number(text) };
	}
	if (operator === 'exists') return { [path]: { $exists: true, $nin: [null, '', []] } };
	if (operator === 'contains_any') return { [path]: { $in: (value as string[]).map(exactRegex) } };
	if (operator === 'contains_all') return { [path]: { $all: (value as string[]).map(exactRegex) } };
	return { [path]: operator === 'equals' ? exactRegex(text) : containsRegex(text) };
}

type BuiltCondition = { query: Document; item?: { tab: string; match: Document } };

const withEntities = (section: ReportSection, matches: Document[]): Document => {
	const all = section.entities ? [{ entity: { $in: section.entities } }, ...matches] : matches;
	return { [section.path!]: { $elemMatch: all.length === 1 ? all[0] : { $and: all } } };
};

function buildCondition(condition: QueryCondition): BuiltCondition {
	const { tab, field: key, operator, value } = condition;
	const { section, field } = getField(condition)!;

	if (field.type === 'count') return { query: buildCountMatch(section, operator, value) };

	const path = field.path ?? key;
	if (field.type === 'date') return { query: buildDateMatch(path, operator, value) };

	const positive = NEGATED[operator] ?? operator;
	const negated = positive !== operator;
	const fullPath = section.isArray || !section.path ? path : `${section.path}.${path}`;
	const match = buildFieldMatch(fullPath, field, positive, value);

	if (!section.isArray) return { query: negated ? negate(match) : match };
	const query = withEntities(section, [match]);
	return negated ? { query: negate(query) } : { query, item: { tab, match } };
}

/**
 * Builds the match for all conditions. Neighbouring conditions on the same list section joined by AND
 * must hold for the same item, so "barcode type is GS1 and barcode is on the pouch" finds one barcode.
 * @param {QueryCondition[]} conditions Validated conditions
 * @param {ConditionLogic} conditionLogic Logic used when no condition has its own
 * @return {Document} Combined match
 */
export function buildConditionsMatch(conditions: QueryCondition[], conditionLogic?: ConditionLogic): Document {
	const chained = conditions.some((condition) => condition.logic);
	const logicAt = (index: number) => (chained ? conditions[index].logic || 'AND' : conditionLogic || 'AND');

	const groups: { logic?: ConditionLogic; joinedByAnd: boolean; built: BuiltCondition; matches: Document[] }[] = [];
	conditions.forEach((condition, index) => {
		const built = buildCondition(condition);
		const previous = groups[groups.length - 1];
		const joinedByAnd = index > 0 && logicAt(index) === 'AND';
		const isFirstOrAnd = previous && (groups.length === 1 || previous.joinedByAnd);
		if (built.item && previous?.built.item?.tab === built.item.tab && joinedByAnd && isFirstOrAnd) {
			previous.matches.push(built.item.match);
			return;
		}
		groups.push({
			logic: chained && index > 0 ? logicAt(index) : undefined,
			joinedByAnd,
			built,
			matches: built.item ? [built.item.match] : [],
		});
	});

	const queries = groups.map(({ built, matches }) => (
		built.item && matches.length > 1 ? withEntities(REPORT_SECTIONS[built.item.tab], matches) : built.query
	));
	return combineConditionQueries(groups, queries, conditionLogic);
}

/**
 * Joins condition matches. When any condition has its own `logic`, they are chained left to right;
 * otherwise all of them are joined with `conditionLogic`.
 * @param {Array} conditions Conditions, each with an optional `logic`
 * @param {Document[]} conditionQueries One match per condition
 * @param {ConditionLogic} conditionLogic Logic used when no condition has its own
 * @return {Document} Combined match
 */
export function combineConditionQueries(
	conditions: { logic?: ConditionLogic }[],
	conditionQueries: Document[],
	conditionLogic?: ConditionLogic,
): Document {
	if (conditions.some((condition) => condition.logic)) {
		let groupedQuery = conditionQueries[0];
		for (let i = 1; i < conditionQueries.length; i += 1) {
			const conditionLogicValue = conditions[i].logic || 'AND';
			const operator = conditionLogicValue === 'OR' ? '$or' : '$and';
			groupedQuery = {
				[operator]: [groupedQuery, conditionQueries[i]],
			};
		}
		return groupedQuery;
	}

	const logicOperator = conditionLogic === 'OR' ? '$or' : '$and';
	return {
		[logicOperator]: conditionQueries,
	};
}

const PERSON_LOOKUPS: Record<string, { localField: string; as: string }> = {
	owner: { localField: 'owner_user_id', as: 'report_owner' },
	contributors: { localField: 'contributor_user_ids', as: 'report_contributors' },
};

function buildLookups(conditions: QueryCondition[], workspaceId: ObjectId): Document[] {
	const pipeline: Document[] = [];
	const rootFields = new Set(conditions
		.filter((condition) => hasOwn(REPORT_SECTIONS, condition.tab) && !REPORT_SECTIONS[condition.tab].path)
		.map((condition) => condition.field));

	for (const parent of ['department', 'project']) {
		const fields = [`${parent}_name`, `${parent}_description`];
		if (parent === 'project') fields.push('project_number');
		if (!fields.some((field) => rootFields.has(field))) continue;

		const alias = `report_${parent}`;
		pipeline.push({
			$lookup: {
				from: `${parent}s`,
				let: { parentId: { $convert: { input: `$${parent}_id`, to: 'objectId', onError: null, onNull: null } } },
				pipeline: [
					{ $match: { workspace_id: workspaceId, $expr: { $eq: ['$_id', '$$parentId'] } } },
					{ $project: Object.fromEntries(fields.map((field) => [field, 1])) },
				],
				as: alias,
			},
		});
		pipeline.push({
			$set: Object.fromEntries(fields.map((field) => [
				field, { $ifNull: [{ $arrayElemAt: [`$${alias}.${field}`, 0] }, null] },
			])),
		});
	}

	for (const [field, { localField, as }] of Object.entries(PERSON_LOOKUPS)) {
		if (!rootFields.has(field)) continue;
		pipeline.push({
			$lookup: { from: 'users', localField, foreignField: '_id', pipeline: [{ $project: { name: 1, email: 1 } }], as },
		});
	}
	return pipeline;
}

function buildFilterStages(request: ReportsQueryRequest | ReportsExportRequest, workspaceId: ObjectId): Document[] {
	const { conditions, conditionLogic } = request;
	const pipeline: Document[] = [{ $match: { workspace_id: workspaceId } }];
	if (conditions && conditions.length > 0) {
		pipeline.push(...buildLookups(conditions, workspaceId));
		pipeline.push({ $match: buildConditionsMatch(conditions, conditionLogic) });
	}
	return pipeline;
}

function buildSort(request: ReportsQueryRequest | ReportsExportRequest): Document {
	const { sort } = request;
	if (!sort?.field) return { product_name: 1 };
	if (!ALLOWED_SORT_FIELDS.includes(sort.field)) {
		throw new Error(`Invalid sort field. Allowed fields: ${ALLOWED_SORT_FIELDS.join(', ')}`);
	}
	return { [sort.field]: sort.order === 'desc' ? -1 : 1 };
}

export const REPORT_RESULT_PROJECTION = {
	_id: 1,
	product_name: 1,
	product_plan_number: 1,
	product_description: 1,
	department_id: 1,
	project_id: 1,
	status: 1,
	is_archived: 1,
	target_date: 1,
	actual_completion_date: 1,
	released_at: 1,
	version: 1,
	owner_user_id: 1,
	'product_information.data.market_geography': 1,
	'product_information.data.country_of_origin': 1,
	'product_information.data.commercial_clinical': 1,
	'product_information.data.manufacturing_location': 1,
	'product_information.data.oem_contract_manufacturer': 1,
	'product_information.data.class_of_device': 1,
	'product_information.data.basic_udi_di': 1,
	'languages_information.data.name': 1,
};

export function buildAggregationPipeline(
	request: ReportsQueryRequest | ReportsExportRequest,
	workspaceId: ObjectId,
): Document[] {
	const page = request.pagination?.page || 1;
	const limit = request.pagination?.limit || 10;

	return [
		...buildFilterStages(request, workspaceId),
		{
			$facet: {
				metadata: [{ $count: 'total' }],
				data: [
					{ $sort: buildSort(request) },
					{ $skip: (page - 1) * limit },
					{ $limit: limit },
					{ $project: REPORT_RESULT_PROJECTION },
				],
			},
		},
	];
}

export function buildExportPipeline(
	request: ReportsExportRequest,
	workspaceId: ObjectId,
	maxLimit: number,
): Document[] {
	return [
		...buildFilterStages(request, workspaceId),
		{ $sort: buildSort(request) },
		{ $limit: maxLimit },
		{
			$project: {
				_id: 1,
				product_name: 1,
				product_plan_number: 1,
				product_description: 1,
				department_id: 1,
				project_id: 1,
				status: 1,
				target_date: 1,
				version: 1,
				'product_information.data': 1,
				...Object.fromEntries(COMPLETION_TABS.map((tab) => [`${tab}.tab_completed`, 1])),
			},
		},
	];
}
