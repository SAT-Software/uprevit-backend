/* eslint-disable require-jsdoc */
import { Db, ObjectId } from 'mongodb';
import { AUDIT_LOG_V2_COLLECTION } from '../models/auditLogV2';

export const DASHBOARD_ACTIVITY_WINDOW_DAYS = 30;

const PRODUCT_CREATION_EVENT_KEYS = ['product.created', 'product.version.created'] as const;

export type ActivityBreakdown = {
	created_only: number;
	updated_only: number;
	both: number;
	total: number;
};

export type ArchiveActivityBreakdown = {
	departments: number;
	projects: number;
	products: number;
	total: number;
};

export type DashboardActivityStats = {
	window_days: number;
	departments: ActivityBreakdown;
	projects: ActivityBreakdown;
	products: ActivityBreakdown;
	source_files: ActivityBreakdown;
	archives: ArchiveActivityBreakdown;
};

function emptyBreakdown(): ActivityBreakdown {
	return { created_only: 0, updated_only: 0, both: 0, total: 0 };
}

function emptyArchiveBreakdown(): ArchiveActivityBreakdown {
	return { departments: 0, projects: 0, products: 0, total: 0 };
}

function breakdownFromFacetSets(
	createdIds: unknown[] | undefined,
	updatedIds: unknown[] | undefined,
): ActivityBreakdown {
	const createdSet = new Set((createdIds ?? []).map(String));
	const updatedSet = new Set((updatedIds ?? []).map(String));

	let createdOnly = 0;
	let both = 0;

	for (const id of createdSet) {
		if (updatedSet.has(id)) {
			both += 1;
		} else {
			createdOnly += 1;
		}
	}

	let updatedOnly = 0;
	for (const id of updatedSet) {
		if (!createdSet.has(id)) {
			updatedOnly += 1;
		}
	}

	return {
		created_only: createdOnly,
		updated_only: updatedOnly,
		both,
		total: createdOnly + updatedOnly + both,
	};
}

export function getActivityWindowStart(days = DASHBOARD_ACTIVITY_WINDOW_DAYS): Date {
	const since = new Date();
	since.setDate(since.getDate() - days);
	return since;
}

async function aggregateProductActivity(
	db: Db,
	workspaceId: ObjectId,
	since: Date,
): Promise<Pick<DashboardActivityStats, 'departments' | 'projects' | 'products'>> {
	const results = await db.collection(AUDIT_LOG_V2_COLLECTION).aggregate([
		{
			$match: {
				workspaceId,
				occurredAt: { $gte: since },
				'scope.type': 'product',
				$or: [
					{ action: 'update' },
					{ action: 'create' },
					{ eventKey: { $in: PRODUCT_CREATION_EVENT_KEYS } },
				],
			},
		},
		{
			$addFields: {
				activityType: {
					$cond: [
						{
							$or: [
								{ $eq: ['$action', 'create'] },
								{ $in: ['$eventKey', PRODUCT_CREATION_EVENT_KEYS] },
							],
						},
						'create',
						'update',
					],
				},
				productObjectId: {
					$convert: {
						input: '$scope.id',
						to: 'objectId',
						onError: null,
						onNull: null,
					},
				},
			},
		},
		{
			$match: {
				productObjectId: { $ne: null },
			},
		},
		{
			$group: {
				_id: {
					productId: '$productObjectId',
					activityType: '$activityType',
				},
			},
		},
		{
			$lookup: {
				from: 'products',
				localField: '_id.productId',
				foreignField: '_id',
				as: 'product',
			},
		},
		{ $unwind: '$product' },
		{
			$match: {
				'product.workspace_id': workspaceId,
			},
		},
		{
			$addFields: {
				isActiveProduct: { $ne: ['$product.status', 'archived'] },
			},
		},
		{
			$lookup: {
				from: 'departments',
				localField: 'product.department_id',
				foreignField: '_id',
				as: 'department',
			},
		},
		{
			$lookup: {
				from: 'projects',
				localField: 'product.project_id',
				foreignField: '_id',
				as: 'project',
			},
		},
		{
			$addFields: {
				departmentId: {
					$cond: [
						{
							$and: [
								'$isActiveProduct',
								{ $gt: [{ $size: '$department' }, 0] },
								{ $eq: [{ $arrayElemAt: ['$department.isArchived', 0] }, false] },
							],
						},
						{ $arrayElemAt: ['$department._id', 0] },
						null,
					],
				},
				projectId: {
					$cond: [
						{
							$and: [
								'$isActiveProduct',
								{ $gt: [{ $size: '$project' }, 0] },
								{ $eq: [{ $arrayElemAt: ['$project.isArchived', 0] }, false] },
							],
						},
						{ $arrayElemAt: ['$project._id', 0] },
						null,
					],
				},
			},
		},
		{
			$facet: {
				productsCreated: [
					{ $match: { '_id.activityType': 'create' } },
					{ $group: { _id: null, ids: { $addToSet: '$_id.productId' } } },
				],
				productsUpdated: [
					{ $match: { '_id.activityType': 'update' } },
					{ $group: { _id: null, ids: { $addToSet: '$_id.productId' } } },
				],
				departmentsCreated: [
					{ $match: { '_id.activityType': 'create', departmentId: { $ne: null } } },
					{ $group: { _id: null, ids: { $addToSet: '$departmentId' } } },
				],
				departmentsUpdated: [
					{ $match: { '_id.activityType': 'update', departmentId: { $ne: null } } },
					{ $group: { _id: null, ids: { $addToSet: '$departmentId' } } },
				],
				projectsCreated: [
					{ $match: { '_id.activityType': 'create', projectId: { $ne: null } } },
					{ $group: { _id: null, ids: { $addToSet: '$projectId' } } },
				],
				projectsUpdated: [
					{ $match: { '_id.activityType': 'update', projectId: { $ne: null } } },
					{ $group: { _id: null, ids: { $addToSet: '$projectId' } } },
				],
			},
		},
	]).toArray();

	const facet = results[0] ?? {};

	return {
		products: breakdownFromFacetSets(
			facet.productsCreated?.[0]?.ids,
			facet.productsUpdated?.[0]?.ids,
		),
		departments: breakdownFromFacetSets(
			facet.departmentsCreated?.[0]?.ids,
			facet.departmentsUpdated?.[0]?.ids,
		),
		projects: breakdownFromFacetSets(
			facet.projectsCreated?.[0]?.ids,
			facet.projectsUpdated?.[0]?.ids,
		),
	};
}

async function aggregateSourceFileActivity(
	db: Db,
	workspaceId: ObjectId,
	since: Date,
): Promise<ActivityBreakdown> {
	const results = await db.collection(AUDIT_LOG_V2_COLLECTION).aggregate([
		{
			$match: {
				workspaceId,
				occurredAt: { $gte: since },
				'entity.type': 'source_file',
				action: { $in: ['create', 'update'] },
			},
		},
		{
			$addFields: {
				activityType: {
					$cond: [{ $eq: ['$action', 'create'] }, 'create', 'update'],
				},
				fileObjectId: {
					$convert: {
						input: '$entity.id',
						to: 'objectId',
						onError: null,
						onNull: null,
					},
				},
			},
		},
		{
			$match: {
				fileObjectId: { $ne: null },
			},
		},
		{
			$group: {
				_id: {
					fileId: '$fileObjectId',
					activityType: '$activityType',
				},
			},
		},
		{
			$lookup: {
				from: 'sourceFiles',
				localField: '_id.fileId',
				foreignField: '_id',
				as: 'sourceFile',
			},
		},
		{ $unwind: '$sourceFile' },
		{
			$match: {
				'sourceFile.workspace_id': workspaceId,
				'sourceFile.type': 'file',
			},
		},
		{
			$facet: {
				created: [
					{ $match: { '_id.activityType': 'create' } },
					{ $group: { _id: null, ids: { $addToSet: '$_id.fileId' } } },
				],
				updated: [
					{ $match: { '_id.activityType': 'update' } },
					{ $group: { _id: null, ids: { $addToSet: '$_id.fileId' } } },
				],
			},
		},
	]).toArray();

	const facet = results[0] ?? {};

	return breakdownFromFacetSets(
		facet.created?.[0]?.ids,
		facet.updated?.[0]?.ids,
	);
}

async function aggregateArchiveActivity(
	db: Db,
	workspaceId: ObjectId,
	since: Date,
): Promise<ArchiveActivityBreakdown> {
	const results = await db.collection(AUDIT_LOG_V2_COLLECTION).aggregate([
		{
			$match: {
				workspaceId,
				occurredAt: { $gte: since },
				action: 'archive',
				'scope.type': { $in: ['department', 'project', 'product'] },
			},
		},
		{
			$group: {
				_id: {
					type: '$scope.type',
					id: '$scope.id',
				},
			},
		},
		{
			$facet: {
				departments: [
					{ $match: { '_id.type': 'department' } },
					{ $count: 'count' },
				],
				projects: [
					{ $match: { '_id.type': 'project' } },
					{ $count: 'count' },
				],
				products: [
					{ $match: { '_id.type': 'product' } },
					{ $count: 'count' },
				],
			},
		},
	]).toArray();

	const facet = results[0] ?? {};
	const departments = facet.departments?.[0]?.count ?? 0;
	const projects = facet.projects?.[0]?.count ?? 0;
	const products = facet.products?.[0]?.count ?? 0;

	return {
		departments,
		projects,
		products,
		total: departments + projects + products,
	};
}

export async function getDashboardActivityStats(
	db: Db,
	workspaceId: ObjectId,
	since = getActivityWindowStart(),
): Promise<DashboardActivityStats> {
	const [productActivity, sourceFileActivity, archiveActivity] = await Promise.all([
		aggregateProductActivity(db, workspaceId, since),
		aggregateSourceFileActivity(db, workspaceId, since),
		aggregateArchiveActivity(db, workspaceId, since),
	]);

	return {
		window_days: DASHBOARD_ACTIVITY_WINDOW_DAYS,
		departments: productActivity.departments,
		projects: productActivity.projects,
		products: productActivity.products,
		source_files: sourceFileActivity,
		archives: archiveActivity,
	};
}

export function emptyDashboardActivityStats(): DashboardActivityStats {
	return {
		window_days: DASHBOARD_ACTIVITY_WINDOW_DAYS,
		departments: emptyBreakdown(),
		projects: emptyBreakdown(),
		products: emptyBreakdown(),
		source_files: emptyBreakdown(),
		archives: emptyArchiveBreakdown(),
	};
}
