import { APIGatewayProxyResult } from 'aws-lambda';
import { Document } from 'mongodb';
import { ResponseWrapper } from './responseWrapper';

export type ListFilterOperator =
	| 'eq'
	| 'neq'
	| 'contains'
	| 'not_contains'
	| 'starts_with'
	| 'ends_with'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'is_null'
	| 'is_not_null';

export type ListFilter = {
	field: string;
	operator: ListFilterOperator;
	value?: unknown;
};

export type ListFieldType = 'text' | 'number' | 'date' | 'boolean';

export type ListFilterField = {
	path: string;
	type: ListFieldType;
};

type ParseListQueryInput = {
	query?: Record<string, string | undefined> | null;
	allowedSortFields: string[];
	defaultSort: string;
	defaultOrder?: 'asc' | 'desc';
};

type ParsedListQuery = {
	page: number;
	limit: number;
	sort: string;
	order: 'asc' | 'desc';
	skip: number;
	filters: ListFilter[];
};

type ParseListQueryResult = {
	value?: ParsedListQuery;
	error?: APIGatewayProxyResult;
};

const FILTER_OPERATORS: ListFilterOperator[] = [
	'eq',
	'neq',
	'contains',
	'not_contains',
	'starts_with',
	'ends_with',
	'gt',
	'gte',
	'lt',
	'lte',
	'is_null',
	'is_not_null',
];

const NO_VALUE_OPERATORS: ListFilterOperator[] = ['is_null', 'is_not_null'];

/**
 * Parses positive integer query params with a default fallback.
 *
 * @param {string | undefined} value Query string value to parse.
 * @param {number} fallback Default value when the query value is omitted.
 * @param {string} name Human-readable field name for validation errors.
 * @return {number | string} Parsed integer or an error message.
 */
function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number | string {
	if (value === undefined || value === '') return fallback;
	if (!/^\d+$/.test(value)) return `${name} must be a positive integer`;
	return Number(value);
}

/**
 * Checks whether an unknown value is a supported list filter shape.
 *
 * @param {unknown} value Value to inspect.
 * @return {boolean} True when the value is a valid list filter.
 */
function isListFilter(value: unknown): value is ListFilter {
	if (!value || typeof value !== 'object') return false;

	const filter = value as Partial<ListFilter>;
	return typeof filter.field === 'string' && FILTER_OPERATORS.includes(filter.operator as ListFilterOperator);
}

/**
 * Parses and validates common list pagination, sort, order, and filter params.
 *
 * @param {ParseListQueryInput} input Query parsing input.
 * @return {ParseListQueryResult} Parsed list query values or a response error.
 */
export function parseListQuery(input: ParseListQueryInput): ParseListQueryResult {
	const {
		query,
		allowedSortFields,
		defaultSort,
		defaultOrder = 'asc',
	} = input;
	const limitResult = parsePositiveInteger(query?.limit, 10, 'Limit');
	if (typeof limitResult === 'string') return { error: ResponseWrapper.badRequest(limitResult) };
	if (limitResult < 1 || limitResult > 100) {
		return { error: ResponseWrapper.badRequest('Limit must be between 1 and 100') };
	}

	const pageResult = parsePositiveInteger(query?.page, 1, 'Page');
	if (typeof pageResult === 'string') return { error: ResponseWrapper.badRequest(pageResult) };
	if (pageResult < 1) return { error: ResponseWrapper.badRequest('Page must be greater than 0') };

	const sort = query?.sort || defaultSort;
	if (!allowedSortFields.includes(sort)) {
		return { error: ResponseWrapper.badRequest(`Invalid sort field. Allowed fields: ${allowedSortFields.join(', ')}`) };
	}

	const order = query?.order || defaultOrder;
	if (order !== 'asc' && order !== 'desc') {
		return { error: ResponseWrapper.badRequest('Order must be asc or desc') };
	}

	let filters: ListFilter[] = [];
	if (query?.filters) {
		try {
			const parsedFilters = JSON.parse(query.filters);
			if (!Array.isArray(parsedFilters)) {
				return { error: ResponseWrapper.badRequest('filters must be a JSON array') };
			}

			for (const filter of parsedFilters) {
				if (!isListFilter(filter)) {
					return { error: ResponseWrapper.badRequest('Each filter must include a valid field and operator') };
				}
				if (!NO_VALUE_OPERATORS.includes(filter.operator) && filter.value === undefined) {
					return { error: ResponseWrapper.badRequest(`Operator '${filter.operator}' requires a value`) };
				}
			}

			filters = parsedFilters;
		} catch {
			return { error: ResponseWrapper.badRequest('filters must be valid JSON') };
		}
	}

	const page = pageResult;
	const limit = limitResult;

	return {
		value: {
			page,
			limit,
			sort,
			order,
			skip: (page - 1) * limit,
			filters,
		},
	};
}

/**
 * Escapes user text before building a Mongo regex filter.
 *
 * @param {string} value Text to escape.
 * @return {string} Regex-safe text.
 */
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses date filter values into Date instances.
 *
 * @param {unknown} value Date value from the filter payload.
 * @param {string} field Filter field name for validation errors.
 * @return {Date | string} Parsed date or an error message.
 */
function parseDateValue(value: unknown, field: string): Date | string {
	if (typeof value !== 'string') return `Filter '${field}' must use a date string`;

	const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
		? new Date(`${value}T00:00:00.000Z`)
		: new Date(value);

	if (Number.isNaN(date.getTime())) return `Filter '${field}' must use a valid date`;
	return date;
}

/**
 * Returns the UTC day boundary after a parsed date-only value.
 *
 * @param {Date} date Start date.
 * @return {Date} Next UTC day.
 */
function getNextUtcDay(date: Date): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

/**
 * Normalizes filter values to the configured field type.
 *
 * @param {unknown} value Raw filter value.
 * @param {string} field Filter field name for validation errors.
 * @param {ListFieldType} type Configured field type.
 * @return {unknown | string} Normalized value or an error message.
 */
function normalizeFilterValue(value: unknown, field: string, type: ListFieldType): unknown | string {
	if (type === 'text') {
		if (typeof value !== 'string') return `Filter '${field}' must use a string value`;
		return value;
	}

	if (type === 'number') {
		if (typeof value === 'number') {
			if (Number.isNaN(value)) return `Filter '${field}' must use a numeric value`;
			return value;
		}
		if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
			return Number(value);
		}
		return `Filter '${field}' must use a numeric value`;
	}

	if (type === 'boolean') {
		if (typeof value === 'boolean') return value;
		if (value === 'true') return true;
		if (value === 'false') return false;
		return `Filter '${field}' must use a boolean value`;
	}

	return parseDateValue(value, field);
}

/**
 * Builds a Mongo query for null and not-null filter operators.
 *
 * @param {string} path Mongo field path.
 * @param {boolean} isNull Whether to match null-like values.
 * @return {Document} Mongo query document.
 */
function buildNullQuery(path: string, isNull: boolean): Document {
	if (isNull) {
		return { $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: '' }] };
	}
	return { [path]: { $exists: true, $nin: [null, ''] } };
}

/**
 * Builds whole-day Mongo comparisons for date-only filter values.
 *
 * @param {string} path Mongo field path.
 * @param {ListFilterOperator} operator Filter operator.
 * @param {Date} value Parsed start-of-day date.
 * @return {Document | string} Mongo query document or an error message.
 */
function buildDateOnlyQuery(path: string, operator: ListFilterOperator, value: Date): Document | string {
	const end = getNextUtcDay(value);
	switch (operator) {
	case 'eq':
		return { [path]: { $gte: value, $lt: end } };
	case 'neq':
		return { $or: [{ [path]: { $lt: value } }, { [path]: { $gte: end } }] };
	case 'gt':
		return { [path]: { $gte: end } };
	case 'gte':
		return { [path]: { $gte: value } };
	case 'lt':
		return { [path]: { $lt: value } };
	case 'lte':
		return { [path]: { $lt: end } };
	default:
		return `Unsupported operator '${operator}'`;
	}
}

/**
 * Builds a Mongo query for one validated list filter.
 *
 * @param {ListFilter} filter Filter to convert.
 * @param {ListFilterField} fieldConfig Allowed field configuration.
 * @return {Document | string} Mongo query document or an error message.
 */
function buildFilterQuery(filter: ListFilter, fieldConfig: ListFilterField): Document | string {
	const { operator, value } = filter;
	const { path, type } = fieldConfig;

	if (operator === 'is_null' || operator === 'is_not_null') {
		return buildNullQuery(path, operator === 'is_null');
	}

	const normalizedValue = normalizeFilterValue(value, filter.field, type);
	const isNormalizeError =
		typeof normalizedValue === 'string' && (type !== 'text' || typeof value !== 'string');
	if (isNormalizeError) return normalizedValue;

	if (type !== 'text' && ['contains', 'not_contains', 'starts_with', 'ends_with'].includes(operator)) {
		return `Operator '${operator}' is only supported for text fields`;
	}

	if (!['number', 'date'].includes(type) && ['gt', 'gte', 'lt', 'lte'].includes(operator)) {
		return `Operator '${operator}' is only supported for number and date fields`;
	}

	if (type === 'date' && normalizedValue instanceof Date && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
		return buildDateOnlyQuery(path, operator, normalizedValue);
	}

	switch (operator) {
	case 'eq':
		return { [path]: normalizedValue };
	case 'neq':
		return { [path]: { $ne: normalizedValue } };
	case 'contains':
		return { [path]: { $regex: escapeRegex(String(normalizedValue)), $options: 'i' } };
	case 'not_contains':
		return { [path]: { $not: { $regex: escapeRegex(String(normalizedValue)), $options: 'i' } } };
	case 'starts_with':
		return { [path]: { $regex: `^${escapeRegex(String(normalizedValue))}`, $options: 'i' } };
	case 'ends_with':
		return { [path]: { $regex: `${escapeRegex(String(normalizedValue))}$`, $options: 'i' } };
	case 'gt':
		return { [path]: { $gt: normalizedValue } };
	case 'gte':
		return { [path]: { $gte: normalizedValue } };
	case 'lt':
		return { [path]: { $lt: normalizedValue } };
	case 'lte':
		return { [path]: { $lte: normalizedValue } };
	default:
		return `Unsupported operator '${operator}'`;
	}
}

/**
 * Builds a Mongo match document from an AND-matched list filter set.
 *
 * @param {ListFilter[]} filters Filters to convert.
 * @param {Record<string, ListFilterField>} allowedFields Allowed field map.
 * @return {Object} Mongo match or response error.
 */
export function buildListFiltersMatch(
	filters: ListFilter[],
	allowedFields: Record<string, ListFilterField>,
): { match?: Document; error?: APIGatewayProxyResult } {
	if (filters.length === 0) return {};

	const conditions: Document[] = [];
	for (const filter of filters) {
		const fieldConfig = allowedFields[filter.field];
		if (!fieldConfig) {
			return {
				error: ResponseWrapper.badRequest(
					`Invalid filter field '${filter.field}'. Allowed fields: ${Object.keys(allowedFields).join(', ')}`,
				),
			};
		}

		const query = buildFilterQuery(filter, fieldConfig);
		if (typeof query === 'string') return { error: ResponseWrapper.badRequest(query) };
		conditions.push(query);
	}

	return { match: conditions.length === 1 ? conditions[0] : { $and: conditions } };
}
