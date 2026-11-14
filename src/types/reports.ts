import { PRODUCT_TABS } from '../utils/productTabs';

export type QueryOperator =
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'not_contains'
    | 'exists'
    | 'not_exists'
    | 'contains_any'
    | 'contains_all'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'on'
    | 'before'
    | 'after';

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

export type PersistedReportExportRequest = Pick<ReportsExportRequest, 'conditions' | 'conditionLogic' | 'sort'>;

export type ReportFieldType =
	| 'text'
	| 'option'
	| 'boolean'
	| 'presence'
	| 'number'
	| 'date'
	| 'list'
	| 'person'
	| 'tab'
	| 'count';

export type ReportField = { type: ReportFieldType; path?: string; options?: readonly string[] };

export type ReportSection = {
	path?: string;
	isArray?: boolean;
	entities?: readonly string[];
	fields: Record<string, ReportField>;
};

const text: ReportField = { type: 'text' };
const list: ReportField = { type: 'list' };
const itemCount: ReportField = { type: 'count' };

const graphicSection = (entities: readonly string[], fields: Record<string, ReportField> = {}): ReportSection => ({
	path: 'symbols_graphics.data',
	isArray: true,
	entities,
	fields: { text, description: text, label_presence: list, ...fields, item_count: itemCount },
});

export const REPORT_SECTIONS: Record<string, ReportSection> = {
	root: {
		fields: {
			product_name: text,
			product_description: text,
			product_plan_number: text,
			department_name: text,
			department_description: text,
			project_name: text,
			project_description: text,
			project_number: text,
			status: { type: 'option', options: ['draft', 'submitted', 'in_review', 'released', 'obsolete'] },
			version: { type: 'number' },
			is_latest: { type: 'boolean' },
			is_archived: { type: 'boolean' },
		},
	},
	dates: {
		fields: {
			created_at: { type: 'date', path: '_id' },
			target_date: { type: 'date' },
			actual_completion_date: { type: 'date' },
			released_at: { type: 'date' },
			obsoleted_at: { type: 'date' },
			archived_at: { type: 'date' },
		},
	},
	team: {
		fields: {
			owner: { type: 'person', path: 'report_owner' },
			contributors: { type: 'person', path: 'report_contributors' },
			in_active_workflow: { type: 'presence', path: 'active_workflow_id' },
			released_by_workflow: { type: 'presence', path: 'released_by_workflow_id' },
			legacy_release: { type: 'boolean' },
		},
	},
	progress: {
		fields: {
			completed_tab: { type: 'tab', options: PRODUCT_TABS.map((tab) => tab.field) },
			complete_count: { type: 'number' },
		},
	},
	product_information: {
		path: 'product_information.data',
		fields: {
			market_geography: text,
			country_of_origin: text,
			commercial_clinical: text,
			manufacturing_location: text,
			oem_contract_manufacturer: text,
			class_of_device: text,
			basic_udi_di: text,
		},
	},
	custom_fields: {
		path: 'product_information.custom_fields',
		isArray: true,
		fields: { label: text, value: text, item_count: itemCount },
	},
	compliance_information: {
		path: 'compliance_information.data',
		isArray: true,
		fields: { standard: text, standard_description: text, item_count: itemCount },
	},
	languages_information: {
		path: 'languages_information.data',
		isArray: true,
		fields: { code: text, name: text, country: text, item_count: itemCount },
	},
	symbols: graphicSection(['Symbols'], {
		text_present: { type: 'boolean' },
		standard_ref_number: text,
		is_standard: { type: 'presence', path: 'standard_symbol_id' },
	}),
	schematics: graphicSection(['Schematics']),
	barcodes: graphicSection(['Barcodes'], { count: { type: 'number' } }),
	other_components: graphicSection(['Other Components', 'OtherComponents']),
	label_components: {
		path: 'label_components.data',
		isArray: true,
		fields: {
			component_type: text,
			component_number: text,
			component_description: text,
			label_type: list,
			dimensions: text,
			print_direction: text,
			item_count: itemCount,
		},
	},
	label_tags: {
		path: 'label_tags.data',
		isArray: true,
		fields: {
			name: text,
			description: text,
			type: text,
			legend_text: { type: 'list', path: 'legend_items.text' },
			item_count: itemCount,
		},
	},
};

const TEXT_OPERATORS: QueryOperator[] = ['equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists'];
const COMPARE_OPERATORS: QueryOperator[] = ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte'];

export const REPORT_OPERATORS: Record<ReportFieldType, QueryOperator[]> = {
	text: TEXT_OPERATORS,
	person: TEXT_OPERATORS,
	option: ['equals', 'not_equals'],
	boolean: ['equals', 'not_equals'],
	presence: ['equals', 'not_equals'],
	tab: ['equals', 'not_equals'],
	number: [...COMPARE_OPERATORS, 'exists', 'not_exists'],
	count: COMPARE_OPERATORS,
	date: ['on', 'before', 'after', 'exists', 'not_exists'],
	list: ['contains', 'not_contains', 'contains_any', 'contains_all', 'exists', 'not_exists'],
};

export const NO_VALUE_OPERATORS = ['exists', 'not_exists'];

export const ARRAY_OPERATORS = ['contains_any', 'contains_all'];

export const EXPORT_LIMITS = {
	PDF: 1000,
	EXCEL: 1000,
};

export const ALLOWED_SORT_FIELDS = ['product_name', 'product_plan_number', 'status', 'version', 'target_date'];
