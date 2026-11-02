import { type Db, ObjectId } from 'mongodb';
import type { Product } from '../models/product';
import { computeCompleteCount } from './productLifecycle';

export const MAX_IMPORT_PRODUCTS = 50;
export const COMPONENT_TYPES = ['Preprinted', 'Blank', 'N/A'];

export type ImportProductInput = {
	product_plan_number: string;
	product_name: string;
	product_description: string;
	target_date?: string | null;
	project_id?: string | null;
	new_project?: { department_name: string; project_name: string; project_number: string } | null;
	product_information?: Partial<Record<
		'market_geography' | 'country_of_origin' | 'oem_contract_manufacturer' | 'commercial_clinical' |
		'manufacturing_location' | 'class_of_device' | 'basic_udi_di', string
	>>;
	custom_fields?: Array<{ label: string; value: string }>;
	compliance?: Array<{ standard: string; standard_description: string }>;
	languages?: Array<{ code: string; name: string; country?: string }>;
	label_components?: Array<{
		component_number: string;
		component_type: string;
		component_description?: string;
		dimensions?: string;
		label_type?: string[];
		print_direction?: string;
	}>;
};

const INFO_FIELDS = [
	'market_geography', 'country_of_origin', 'oem_contract_manufacturer', 'commercial_clinical',
	'manufacturing_location', 'class_of_device', 'basic_udi_di',
] as const;

export const nameKey = (value: string) => value.trim().toLowerCase();

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const hasDuplicates = (values: string[]) => new Set(values.map(nameKey)).size !== values.length;

/**
 * Checks one imported product against the rules product creation uses.
 * @param {ImportProductInput} input Product from the import file
 * @return {string | null} The first problem found, or null when it can be created
 */
export const validateImportProduct = (input: ImportProductInput): string | null => {
	if (!input || typeof input !== 'object') return 'Invalid product';
	if (!text(input.product_plan_number)) return 'Plan number is required';
	if (text(input.product_plan_number).length > 100) return 'Plan number is longer than 100 characters';
	if (!text(input.product_name)) return 'Product name is required';
	if (!text(input.product_description)) return 'Product description is required';
	if (input.target_date && !/^\d{4}-\d{2}-\d{2}$/.test(input.target_date)) return 'Target date must be yyyy-mm-dd';
	const targetDate = input.target_date ? new Date(`${input.target_date}T00:00:00.000Z`) : null;
	if (targetDate && (Number.isNaN(targetDate.getTime()) || targetDate.toISOString().slice(0, 10) !== input.target_date)) {
		return 'Target date is not a valid date';
	}

	const newProject = input.new_project;
	if (input.project_id) {
		if (!ObjectId.isValid(input.project_id)) return 'Invalid project';
	} else if (newProject) {
		if (!text(newProject.department_name)) return 'Department is required to create a project';
		if (!text(newProject.project_name)) return 'Project name is required';
		if (!text(newProject.project_number)) return 'Project number is required to create a project';
	} else {
		return 'Assign a project';
	}

	const lists = [input.compliance, input.languages, input.label_components, input.custom_fields];
	if (lists.some((list) => list != null && !Array.isArray(list))) return 'Standards, languages, components and custom fields must be lists';

	const compliance = input.compliance ?? [];
	if (compliance.some((item) => !text(item?.standard) || !text(item?.standard_description))) {
		return 'Every standard needs a name and a description';
	}
	if (hasDuplicates(compliance.map((item) => text(item.standard)))) return 'A standard is listed more than once';

	const languages = input.languages ?? [];
	if (languages.some((item) => !text(item?.code) || !text(item?.name))) return 'Every language needs a code and a name';
	if (hasDuplicates(languages.map((item) => text(item.code)))) return 'A language is listed more than once';

	const components = input.label_components ?? [];
	if (components.some((item) => !text(item?.component_number))) return 'Every label component needs a number';
	if (components.some((item) => item.label_type != null && !Array.isArray(item.label_type))) return 'Label types must be a list';
	if (components.some((item) => !COMPONENT_TYPES.includes(text(item.component_type)))) {
		return 'Component type must be Pre-printed, Blank or N/A';
	}
	if (hasDuplicates(components.map((item) => text(item.component_number)))) return 'A component number is used more than once';

	const customFields = input.custom_fields ?? [];
	if (customFields.some((item) => !text(item?.label))) return 'Every custom field needs a label';
	return null;
};

/**
 * Plan numbers already used in the workspace by any version, archived ones included, compared case-insensitively.
 * @param {Db} db Database
 * @param {ObjectId} workspaceId Workspace
 * @return {Promise<Set<string>>} Lower-cased plan numbers
 */
export const findWorkspacePlanNumbers = async (db: Db, workspaceId: ObjectId): Promise<Set<string>> => {
	const planNumbers = await db.collection<Product>('products').distinct('product_plan_number', { workspace_id: workspaceId });
	return new Set(planNumbers.filter((value): value is string => typeof value === 'string').map(nameKey));
};

/**
 * Builds a Draft product with the same shape `createProduct` writes.
 * @param {ImportProductInput} input Validated product from the import file
 * @param {object} target Workspace, project, department and owner of the new product
 * @return {Product} Product document
 */
export const buildImportedProduct = (
	input: ImportProductInput,
	target: { workspaceId: ObjectId; projectId: ObjectId; departmentId: ObjectId; ownerId: ObjectId },
): Product => {
	const productId = new ObjectId();
	const info = input.product_information ?? {};
	const product = {
		_id: productId,
		product_lineage_id: productId,
		is_archived: false,
		owner_user_id: target.ownerId,
		contributor_user_ids: [],
		project_id: target.projectId,
		workspace_id: target.workspaceId,
		department_id: target.departmentId,
		product_plan_number: text(input.product_plan_number),
		product_name: text(input.product_name),
		product_description: text(input.product_description),
		version: 1,
		is_latest: true,
		parent_id: null,
		target_date: input.target_date ? new Date(`${input.target_date}T00:00:00.000Z`).toISOString() : null,
		actual_completion_date: null,
		status: 'draft' as const,
		content_revision: 0,
		product_information: {
			data: {
				_id: new ObjectId(),
				...Object.fromEntries(INFO_FIELDS.map((field) => [field, text(info[field])])),
				custom_fields: [],
			},
			custom_fields: (input.custom_fields ?? []).map((field) => ({
				_id: new ObjectId(),
				label: text(field.label),
				value: text(field.value),
			})),
			tab_completed: false,
		},
		compliance_information: {
			data: (input.compliance ?? []).map((item) => ({
				_id: new ObjectId(),
				standard: text(item.standard),
				standard_description: text(item.standard_description),
			})),
			tab_completed: false,
		},
		languages_information: {
			data: (input.languages ?? []).map((item) => ({
				code: text(item.code),
				name: text(item.name),
				...(text(item.country) ? { country: text(item.country) } : {}),
			})),
		},
		label_components: {
			data: (input.label_components ?? []).map((item) => ({
				_id: new ObjectId(),
				image: null,
				component_number: text(item.component_number),
				component_type: text(item.component_type),
				component_description: text(item.component_description),
				dimensions: text(item.dimensions),
				label_type: (item.label_type ?? []).map(text).filter(Boolean),
				print_direction: text(item.print_direction),
			})),
			tab_completed: false,
		},
		symbols_graphics: { data: [], tab_completed: false },
		product_data: { data: { _id: new ObjectId(), workbook_data: {} }, tab_completed: false },
		operational_parameters: { data: { _id: new ObjectId(), workbook_data: {} }, tab_completed: false },
		label_tags: { data: [], tab_completed: false },
	} as unknown as Product;
	return { ...product, complete_count: computeCompleteCount(product) } as Product;
};
