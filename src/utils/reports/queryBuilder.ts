/* eslint-disable require-jsdoc */
import { ObjectId, Document } from 'mongodb';
import {
	QueryCondition,
	QueryOperator,
	ConditionLogic,
	TAB_CONFIG,
	ROOT_FIELDS,
	VALID_OPERATORS,
	NO_VALUE_OPERATORS,
	ARRAY_OPERATORS,
	ReportsQueryRequest,
	ReportsExportRequest,
	ALLOWED_SORT_FIELDS,
} from '../../types/reports';
import { ResponseWrapper } from '../responseWrapper';
import { APIGatewayProxyResult } from 'aws-lambda';

export function validateCondition(condition: QueryCondition): APIGatewayProxyResult | null {
	if (!VALID_OPERATORS.includes(condition.operator)) {
		return ResponseWrapper.badRequest(
			`Invalid operator '${condition.operator}'. Must be one of: ${VALID_OPERATORS.join(', ')}`,
		);
	}

	const isNoValueOperator = NO_VALUE_OPERATORS.includes(condition.operator);
	const isArrayOperator = ['contains_any', 'contains_all'].includes(condition.operator);

	if (!isNoValueOperator && !isArrayOperator && !condition.value) {
		return ResponseWrapper.badRequest(`Operator '${condition.operator}' requires a value`);
	}

	if (isArrayOperator) {
		if (!condition.value || !Array.isArray(condition.value) || condition.value.length === 0) {
			return ResponseWrapper.badRequest(`Operator '${condition.operator}' requires at least one value`);
		}
	}

	const isRootField = ROOT_FIELDS.includes(condition.field);
	const isValidTab = condition.tab === 'root' || TAB_CONFIG[condition.tab];

	if (!isRootField && !isValidTab) {
		return ResponseWrapper.badRequest(
			`Invalid tab '${condition.tab}'. Must be one of: ${Object.keys(TAB_CONFIG).join(
				', ',
			)}, or 'root' for root-level fields`,
		);
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

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOperatorQuery(operator: QueryOperator, value?: string | string[], field?: string): any {
	switch (operator) {
	case 'equals':
		if (field === 'version' && typeof value === 'string') {
			return parseInt(value, 10);
		}
		return value;
	case 'not_equals':
		if (field === 'version' && typeof value === 'string') {
			return { $ne: parseInt(value, 10) };
		}
		return { $ne: value };
	case 'contains':
		return { $regex: escapeRegex(value as string || ''), $options: 'i' };
	case 'not_contains':
		return { $not: { $regex: escapeRegex(value as string || ''), $options: 'i' } };
	case 'exists':
		return { $exists: true, $ne: null, $nin: ['', null] };
	case 'not_exists':
		return { $in: [null, ''] };
	case 'contains_any':
		if (Array.isArray(value) && value.length > 0) {
			if (field === 'version') {
				return { $in: value.map((v) => parseInt(v, 10)) };
			}
			return { $in: value };
		}
		return { $in: [] };
	case 'contains_all':
		if (Array.isArray(value) && value.length > 0) {
			if (field === 'version') {
				return { $all: value.map((v) => parseInt(v, 10)) };
			}
			return { $all: value };
		}
		return { $in: [] };
	default:
		return value;
	}
}

function buildConditionQuery(condition: QueryCondition): Document {
	const { tab, field, operator, value } = condition;
	const operatorQuery = buildOperatorQuery(operator, value, field);

	if (tab === 'root' || ROOT_FIELDS.includes(field)) {
		if (operator === 'not_exists') {
			return {
				$or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }],
			};
		}
		return { [field]: operatorQuery };
	}

	const tabConfig = TAB_CONFIG[tab];
	if (!tabConfig) return { [field]: operatorQuery };

	if (tabConfig.isArray) {
		if (operator === 'exists') {
			return {
				[tabConfig.path]: {
					$elemMatch: {
						[field]: { $exists: true, $ne: null, $nin: ['', null] },
					},
				},
			};
		}
		if (operator === 'not_exists') {
			return {
				$or: [
					{ [tabConfig.path]: { $size: 0 } },
					{
						[tabConfig.path]: {
							$not: {
								$elemMatch: {
									[field]: { $exists: true, $ne: null, $nin: ['', null] },
								},
							},
						},
					},
				],
			};
		}
		if (ARRAY_OPERATORS.includes(operator)) {
			return {
				[tabConfig.path]: {
					$elemMatch: {
						[field]: operatorQuery,
					},
				},
			};
		}
		return {
			[tabConfig.path]: {
				$elemMatch: { [field]: operatorQuery },
			},
		};
	}

	const fullPath = `${tabConfig.path}.${field}`;
	if (operator === 'not_exists') {
		return {
			$or: [{ [fullPath]: { $exists: false } }, { [fullPath]: null }, { [fullPath]: '' }],
		};
	}
	return { [fullPath]: operatorQuery };
}

function buildConditionsMatch(conditions: QueryCondition[], conditionLogic?: ConditionLogic): Document {
	const conditionQueries = conditions.map(buildConditionQuery);
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

export function buildAggregationPipeline(
	request: ReportsQueryRequest | ReportsExportRequest,
	workspaceId: ObjectId,
): Document[] {
	const { conditions, conditionLogic, pagination, sort } = request;

	const pipeline: Document[] = [];

	const baseMatch: Document = {
		workspace_id: workspaceId,
	};
	pipeline.push({ $match: baseMatch });

	if (conditions && conditions.length > 0) {
		pipeline.push({
			$match: buildConditionsMatch(conditions, conditionLogic),
		});
	}

	const sortObject: Document = {};
	if (sort && sort.field) {
		if (!ALLOWED_SORT_FIELDS.includes(sort.field)) {
			throw new Error(`Invalid sort field. Allowed fields: ${ALLOWED_SORT_FIELDS.join(', ')}`);
		}
		sortObject[sort.field] = sort.order === 'desc' ? -1 : 1;
	} else {
		sortObject['product_name'] = 1;
	}

	const page = pagination?.page || 1;
	const limit = pagination?.limit || 10;
	const skip = (page - 1) * limit;

	pipeline.push({
		$facet: {
			metadata: [{ $count: 'total' }],
			data: [
				{ $sort: sortObject },
				{ $skip: skip },
				{ $limit: limit },
				{
					$project: {
						_id: 1,
						product_name: 1,
						product_plan_number: 1,
						department_id: 1,
						project_id: 1,
						status: 1,
						target_date: 1,
						version: 1,
					},
				},
			],
		},
	});

	return pipeline;
}

export function buildExportPipeline(
	request: ReportsExportRequest,
	workspaceId: ObjectId,
	maxLimit: number,
): Document[] {
	const { conditions, conditionLogic, sort } = request;

	const pipeline: Document[] = [];

	pipeline.push({
		$match: {
			workspace_id: workspaceId,
		},
	});

	if (conditions && conditions.length > 0) {
		pipeline.push({
			$match: buildConditionsMatch(conditions, conditionLogic),
		});
	}

	const sortObject: Document = {};
	if (sort && sort.field) {
		if (!ALLOWED_SORT_FIELDS.includes(sort.field)) {
			throw new Error(`Invalid sort field. Allowed fields: ${ALLOWED_SORT_FIELDS.join(', ')}`);
		}
		sortObject[sort.field] = sort.order === 'desc' ? -1 : 1;
	} else {
		sortObject['product_name'] = 1;
	}
	pipeline.push({ $sort: sortObject });

	pipeline.push({ $limit: maxLimit });

	pipeline.push({
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
			'product_information.tab_completed': 1,
			'compliance_information.tab_completed': 1,
			'symbols_graphics.tab_completed': 1,
			'label_components.tab_completed': 1,
		},
	});

	return pipeline;
}
