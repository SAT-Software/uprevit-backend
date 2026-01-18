
export type QueryOperator =
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'not_contains'
    | 'exists'
    | 'not_exists'
    | 'contains_any'
    | 'contains_all';

export type TabKey =
    | 'product_information'
    | 'compliance_information'
    | 'symbols_graphics'
    | 'label_components'
    | 'root';

export type ConditionLogic = 'AND' | 'OR';

export interface QueryCondition {
    id: string;
    tab: string;
    field: string;
    operator: QueryOperator;
    value?: string | string[];
    logic?: ConditionLogic;
}

export interface ReportsQueryRequest {
    workspaceId: string;
    conditions: QueryCondition[];
    conditionLogic?: ConditionLogic;
    pagination: {
        page: number;
        limit: number;
    };
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
}

export interface ReportsExportRequest {
    workspaceId: string;
    conditions: QueryCondition[];
    conditionLogic?: ConditionLogic;
    pagination?: {
        page: number;
        limit: number;
    };
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
}

export const TAB_CONFIG: Record<string, { path: string; isArray: boolean }> = {
	product_information: {
		path: 'product_information.data',
		isArray: false,
	},
	compliance_information: {
		path: 'compliance_information.data',
		isArray: true,
	},
	symbols_graphics: {
		path: 'symbols_graphics.data',
		isArray: true,
	},
	label_components: {
		path: 'label_components.data',
		isArray: true,
	},
};

export const ROOT_FIELDS = ['status', 'department_id', 'project_id', 'product_name', 'product_plan_number'];

export const VALID_OPERATORS = [
    'equals',
    'not_equals',
    'contains',
    'not_contains',
    'exists',
    'not_exists',
    'contains_any',
    'contains_all',
];

export const NO_VALUE_OPERATORS = ['exists', 'not_exists'];

export const ARRAY_OPERATORS = ['contains_any', 'contains_all'];

export const EXPORT_LIMITS = {
	PDF: 1000,
	EXCEL: 1000,
};

export const ALLOWED_SORT_FIELDS = ['product_name', 'product_plan_number', 'status', 'version', 'target_date'];
