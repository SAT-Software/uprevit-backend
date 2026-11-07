import type { ObjectId } from 'mongodb';
import type { Workspace } from '../models/workspace';
import type { ConditionLogic, QueryCondition } from '../types/reports';
import { getDb } from './db';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type ExportTone = 'gray' | 'blue' | 'amber' | 'green' | 'red' | 'violet';

export const EXPORT_TONES: Record<ExportTone, { fill: string; text: string }> = {
	gray: { fill: '#F3F4F6', text: '#374151' },
	blue: { fill: '#DBEAFE', text: '#1E40AF' },
	amber: { fill: '#FEF3C7', text: '#92400E' },
	green: { fill: '#DCFCE7', text: '#166534' },
	red: { fill: '#FEE2E2', text: '#991B1B' },
	violet: { fill: '#EDE9FE', text: '#5B21B6' },
};

export const PRODUCT_STATUSES = ['draft', 'submitted', 'in_review', 'released', 'obsolete'];

const STATUS_TONES: Record<string, ExportTone> = {
	draft: 'gray',
	submitted: 'blue',
	in_review: 'amber',
	released: 'green',
	obsolete: 'red',
};

export const statusTone = (status?: string): ExportTone => STATUS_TONES[status ?? ''] ?? 'gray';

export const statusLabel = (status?: string): string => {
	const text = (status ?? '').replace(/_/g, ' ').trim();
	return text ? text[0].toUpperCase() + text.slice(1) : '';
};

const toDate = (value?: Date | string | null): Date | undefined => {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
};

export const formatExportDate = (value?: Date | string | null): string => {
	const date = toDate(value);
	return date ? `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : '';
};

export const formatExportTimestamp = (value: Date = new Date()): string =>
	`${formatExportDate(value)}, ${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')} UTC`;

export const listText = (value: unknown): string => (Array.isArray(value) ? value.filter(Boolean).join(', ') : '');

export const yesNo = (value: unknown): string => (value === undefined || value === null ? '' : value ? 'Yes' : 'No');

export type ReportExportContext = {
	workspaceName?: string;
	conditions?: QueryCondition[];
	conditionLogic?: ConditionLogic;
};

export const getExportWorkspaceName = async (workspaceId: ObjectId): Promise<string> => {
	const db = await getDb();
	const workspace = await db.collection<Workspace>('workspaces').findOne({ _id: workspaceId }, { projection: { workspaceName: 1 } });
	return workspace?.workspaceName ?? '';
};

const FILTER_FIELD_LABELS: Record<string, string> = {
	status: 'Status',
	is_archived: 'Archived',
	product_name: 'Product Name',
	product_description: 'Product Description',
	department_name: 'Department Name',
	department_description: 'Department Description',
	project_name: 'Project Name',
	project_description: 'Project Description',
	project_number: 'Project Number',
	product_plan_number: 'Product Plan Number',
	version: 'Version',
	market_geography: 'Market/Geography',
	country_of_origin: 'Country of Origin',
	commercial_clinical: 'Commercial/Clinical',
	manufacturing_location: 'Manufacturing Location',
	oem_contract_manufacturer: 'OEM/Contract Manufacturer',
	class_of_device: 'Class of Device',
	basic_udi_di: 'Basic UDI',
	standard: 'Standard',
	standard_description: 'Standard Description',
	entity: 'Entity Type',
	text: 'Symbol/Graphic Text',
	component_type: 'Component Type',
	component_number: 'Component Number',
	component_description: 'Description',
	label_type: 'Label Type',
};

const FILTER_OPERATOR_LABELS: Record<string, string> = {
	equals: 'equals',
	not_equals: 'does not equal',
	contains: 'contains',
	not_contains: 'does not contain',
	exists: 'has a value',
	not_exists: 'is empty',
	contains_any: 'contains any of',
	contains_all: 'contains all of',
};

export type ReportFilter = { field: string; operator: string; value: string; join?: ConditionLogic };

export const describeReportFilters = ({ conditions = [], conditionLogic }: ReportExportContext): ReportFilter[] => {
	const perCondition = conditions.some((condition) => condition.logic);
	return conditions.map((condition, index) => {
		const values = (Array.isArray(condition.value) ? condition.value : [condition.value ?? '']).map((value) => {
			if (condition.field === 'status') return statusLabel(value);
			if (condition.field === 'is_archived') return value === 'true' ? 'Yes' : value === 'false' ? 'No' : value;
			return value;
		});
		const next = conditions[index + 1];
		return {
			field: FILTER_FIELD_LABELS[condition.field] ?? condition.field,
			operator: FILTER_OPERATOR_LABELS[condition.operator] ?? condition.operator,
			value: ['exists', 'not_exists'].includes(condition.operator) ? '' : values.filter(Boolean).join(', '),
			...(next ? { join: (perCondition ? next.logic : conditionLogic) || 'AND' } : {}),
		};
	});
};
