import { Db, Document, ObjectId } from 'mongodb';
import { WORKFLOWS_COLLECTION } from '../models/workflow';
import { escapeRegex } from './regex';

export const GLOBAL_SEARCH_INDEX = 'global_search';
export const GLOBAL_SEARCH_MIN_LENGTH = 2;
export const GLOBAL_SEARCH_MAX_LENGTH = 100;
export const GLOBAL_SEARCH_LIMIT = 5;

const nameField = [
	{ type: 'string' },
	{ type: 'autocomplete', tokenization: 'edgeGram', minGrams: 2, maxGrams: 15, foldDiacritics: true },
];

/** Atlas Search index definitions, one per collection. The free tier allows three. */
export const GLOBAL_SEARCH_INDEXES: Record<string, Document> = {
	products: {
		mappings: {
			dynamic: false,
			fields: {
				workspace_id: { type: 'objectId' },
				is_latest: { type: 'boolean' },
				is_archived: { type: 'boolean' },
				product_name: nameField,
				product_plan_number: nameField,
				product_description: { type: 'string' },
			},
		},
	},
	projects: {
		mappings: {
			dynamic: false,
			fields: {
				workspace_id: { type: 'objectId' },
				isArchived: { type: 'boolean' },
				project_name: nameField,
				project_number: nameField,
			},
		},
	},
	[WORKFLOWS_COLLECTION]: {
		mappings: {
			dynamic: false,
			fields: {
				workspaceId: { type: 'objectId' },
				name: nameField,
				numberLabel: nameField,
			},
		},
	},
};

export type GlobalSearchItem = {
	id: string;
	title: string;
	code?: string;
	meta?: string;
};

export type GlobalSearchResult = Record<'products' | 'projects' | 'departments' | 'workflows', GlobalSearchItem[]>;

const fuzzyAutocomplete = (query: string, path: string, boost: number) => ({
	autocomplete: { query, path, tokenOrder: 'any', fuzzy: { maxEdits: 1, prefixLength: 1 }, score: { boost: { value: boost } } },
});

type SearchOptions = {
	filter?: Document[];
	mustNot?: Document[];
	textPaths?: string[];
};

const searchStage = (workspace: Document, query: string, namePaths: string[], options: SearchOptions = {}) => ({
	$search: {
		index: GLOBAL_SEARCH_INDEX,
		compound: {
			filter: [{ equals: workspace }, ...(options.filter ?? [])],
			mustNot: options.mustNot ?? [],
			should: [
				...namePaths.map((path, index) => fuzzyAutocomplete(query, path, index === 0 ? 3 : 2)),
				...(options.textPaths ?? []).map((path) => ({ text: { query, path } })),
			],
			minimumShouldMatch: 1,
		},
	},
});

const nameLookup = (from: string, localField: string, as: string, nameField: string) => ({
	$lookup: { from, localField, foreignField: '_id', as, pipeline: [{ $project: { [nameField]: 1 } }] },
});

/**
 * Searches active products, projects, departments and workflows in one workspace.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Caller's workspace
 * @param {string} query Trimmed search text
 * @return {Promise<GlobalSearchResult>} Up to five matches per type
 */
export const runGlobalSearch = async (db: Db, workspaceId: ObjectId, query: string): Promise<GlobalSearchResult> => {
	const limit = { $limit: GLOBAL_SEARCH_LIMIT };

	const [products, projects, departments, workflows] = await Promise.all([
		db.collection('products').aggregate([
			searchStage({ path: 'workspace_id', value: workspaceId }, query, ['product_name', 'product_plan_number'], {
				filter: [{ equals: { path: 'is_latest', value: true } }],
				mustNot: [{ equals: { path: 'is_archived', value: true } }],
				textPaths: ['product_description'],
			}),
			limit,
			nameLookup('projects', 'project_id', 'project', 'project_name'),
			{ $project: { title: '$product_name', code: '$product_plan_number', meta: { $first: '$project.project_name' } } },
		]).toArray(),
		db.collection('projects').aggregate([
			searchStage({ path: 'workspace_id', value: workspaceId }, query, ['project_name', 'project_number'], {
				mustNot: [{ equals: { path: 'isArchived', value: true } }],
			}),
			limit,
			nameLookup('departments', 'department_id', 'department', 'department_name'),
			{ $project: { title: '$project_name', code: '$project_number', meta: { $first: '$department.department_name' } } },
		]).toArray(),
		db.collection('departments').find(
			{ workspace_id: workspaceId, isArchived: { $ne: true }, department_name: { $regex: escapeRegex(query), $options: 'i' } },
			{ projection: { title: '$department_name' }, limit: GLOBAL_SEARCH_LIMIT, sort: { department_name: 1 } },
		).toArray(),
		db.collection(WORKFLOWS_COLLECTION).aggregate([
			searchStage({ path: 'workspaceId', value: workspaceId }, query, ['numberLabel', 'name']),
			limit,
			{ $project: { title: '$name', code: '$numberLabel', meta: '$status' } },
		]).toArray(),
	]);

	const toItems = (docs: Document[]): GlobalSearchItem[] =>
		docs.map(({ _id, title, code, meta }) => ({ id: _id.toString(), title, ...(code && { code }), ...(meta && { meta }) }));

	return { products: toItems(products), projects: toItems(projects), departments: toItems(departments), workflows: toItems(workflows) };
};
