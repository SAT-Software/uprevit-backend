import { Db, Document, ObjectId } from 'mongodb';
import { AUDIT_LOG_V2_COLLECTION } from '../models/auditLogV2';
import { ACTIVE_WORKFLOW_STATUSES, WORKFLOWS_COLLECTION } from '../models/workflow';
import { COMPLETION_TABS } from './productLifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 90;
const CALENDAR_FUTURE_DAYS = 56;
const PRODUCT_CREATION_EVENT_KEYS = ['product.created', 'product.version.created'];

export const PIPELINE_STATUSES = ['draft', 'submitted', 'in_review', 'released'] as const;
const ACTIVE_STATUSES = ['draft', 'submitted', 'in_review'];

export const ANALYTICS_METRICS = ['status', 'due', 'overdue', 'in_progress', 'created', 'released', 'approver', 'tab'] as const;
export type AnalyticsMetric = typeof ANALYTICS_METRICS[number];

export type AnalyticsFilters = {
	workspaceId: ObjectId;
	from: Date;
	to: Date;
	departmentId?: ObjectId;
	projectId?: ObjectId;
};

type QueryParams = Record<string, string | undefined> | null;

const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const validDate = (date: Date, value: string) => (date.toISOString().startsWith(value) ? date : null);
const parseDay = (value: string) =>
	/^\d{4}-\d{2}-\d{2}$/.test(value) ? validDate(new Date(`${value}T00:00:00.000Z`), value) : null;
const parseMonth = (value: string) =>
	/^\d{4}-\d{2}$/.test(value) ? validDate(new Date(`${value}-01T00:00:00.000Z`), value) : null;
const dueDate = (value: unknown) => {
	const date = value ? new Date(value as string) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};
const monthWindow = (month: Date, filters: AnalyticsFilters): [Date, Date] => [
	new Date(Math.max(month.getTime(), filters.from.getTime())),
	new Date(Math.min(nextMonth(month).getTime(), filters.to.getTime())),
];
const nextMonth = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
const toDay = (date: Date) => date.toISOString().slice(0, 10);

export const parseAnalyticsFilters = (
	workspaceId: ObjectId,
	query: QueryParams,
): { filters: AnalyticsFilters } | { error: string } => {
	const to = query?.to ? parseDay(query.to) : startOfDay(new Date());
	const from = query?.from ? parseDay(query.from) : to && new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
	if (!from || !to || from > to) return { error: 'Invalid date range' };

	const filters: AnalyticsFilters = { workspaceId, from, to: new Date(to.getTime() + DAY_MS) };
	for (const key of ['departmentId', 'projectId'] as const) {
		const value = query?.[key];
		if (!value) continue;
		if (!ObjectId.isValid(value)) return { error: `Invalid ${key}` };
		filters[key] = new ObjectId(value);
	}
	return { filters };
};

const targetDate = { $convert: { input: '$target_date', to: 'date', onError: null, onNull: null } };

const targetDateBetween = (from: Date | null, to: Date) => ({
	$expr: {
		$and: [{ $ne: [targetDate, null] }, ...(from ? [{ $gte: [targetDate, from] }] : []), { $lt: [targetDate, to] }],
	},
});

const scopeMatch =  ({ workspaceId, departmentId, projectId }: AnalyticsFilters): Document => ({
	workspace_id: workspaceId,
	...(departmentId && { department_id: departmentId }),
	...(projectId && { project_id: projectId }),
});

const currentMatch = (filters: AnalyticsFilters): Document => ({
	...scopeMatch(filters),
	is_latest: true,
	is_archived: { $ne: true },
});

const releasedMatch = (filters: AnalyticsFilters, from: Date, to: Date): Document => ({
	...scopeMatch(filters),
	released_at: { $gte: from, $lt: to },
});

const creationEvents = (db: Db, workspaceId: ObjectId, from: Date, to: Date) =>
	db.collection(AUDIT_LOG_V2_COLLECTION).aggregate<{ productId: ObjectId; occurredAt: Date }>([
		{
			$match: {
				workspaceId,
				'scope.type': 'product',
				eventKey: { $in: PRODUCT_CREATION_EVENT_KEYS },
				occurredAt: { $gte: from, $lt: to },
			},
		},
		{
			$project: {
				_id: 0,
				occurredAt: 1,
				productId: { $convert: { input: '$scope.id', to: 'objectId', onError: null, onNull: null } },
			},
		},
		{ $match: { productId: { $ne: null } } },
	]).toArray();

const createdProductIds = async (db: Db, filters: AnalyticsFilters, from: Date, to: Date) => {
	const events = await creationEvents(db, filters.workspaceId, from, to);
	const ids = await db
		.collection('products')
		.distinct('_id', { ...scopeMatch(filters), _id: { $in: events.map((event) => event.productId) } });
	const allowed = new Set(ids.map(String));
	return events.filter((event) => allowed.has(String(event.productId)));
};

const pendingAssignments = (db: Db, workspaceId: ObjectId) =>
	db.collection(WORKFLOWS_COLLECTION).aggregate<{ userId: ObjectId; name: string; productIds: ObjectId[] }>([
		{ $match: { workspaceId, status: { $in: ACTIVE_WORKFLOW_STATUSES } } },
		{ $unwind: '$assignments' },
		{ $match: { 'assignments.decision': 'pending' } },
		{
			$project: {
				userId: '$assignments.userId',
				name: '$assignments.userSnapshot.name',
				productIds: {
					$map: {
						input: {
							$filter: {
								input: '$products',
								cond: {
									$or: [
										{ $not: ['$assignments.lineageId'] },
										{ $eq: ['$$this.lineageId', '$assignments.lineageId'] },
									],
								},
							},
						},
						in: '$$this.productVersionId',
					},
				},
			},
		},
	]).toArray();

const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const monthsBetween = (from: Date, to: Date) => {
	const months: string[] = [];
	for (let month = parseMonth(toDay(from).slice(0, 7))!; month < to; month = nextMonth(month)) {
		months.push(toDay(month).slice(0, 7));
	}
	return months;
};

export const getAnalytics = async (db: Db, filters: AnalyticsFilters) => {
	const products = db.collection('products');
	const now = new Date();
	const today = startOfDay(now);
	const calendarFrom = filters.from;
	const calendarTo = new Date(today.getTime() + CALENDAR_FUTURE_DAYS * DAY_MS);
	const months = monthsBetween(filters.from, filters.to);

	const [current, released, created, assignments] = await Promise.all([
		products
			.find(currentMatch(filters), {
				projection: {
					status: 1,
					target_date: 1,
					department_id: 1,
					product_lineage_id: 1,
					...Object.fromEntries(COMPLETION_TABS.map((tab) => [`${tab}.tab_completed`, 1])),
				},
			})
			.toArray(),
		products
			.find(releasedMatch(filters, filters.from, filters.to), { projection: { released_at: 1, target_date: 1 } })
			.toArray(),
		createdProductIds(db, filters, filters.from, filters.to),
		pendingAssignments(db, filters.workspaceId),
	]);

	const scopedIds = new Set(current.map((product) => String(product._id)));
	const isScoped = Boolean(filters.departmentId || filters.projectId);
	const active = current.filter((product) => ACTIVE_STATUSES.includes(product.status));
	const overdue = active.filter((product) => (dueDate(product.target_date) ?? today) < today);
	const releasedInRange = released.filter((product) => product.released_at >= filters.from);
	const withTarget = releasedInRange.filter((product) => dueDate(product.target_date));

	const createdAt = new Map(created.map((event) => [String(event.productId), event.occurredAt]));
	const missingCreation = releasedInRange.filter((product) => !createdAt.has(String(product._id)));
	if (missingCreation.length) {
		const events = await creationEvents(db, filters.workspaceId, new Date(0), filters.to);
		for (const event of events) createdAt.set(String(event.productId), event.occurredAt);
	}
	const daysToRelease = releasedInRange.flatMap((product) => {
		const start = createdAt.get(String(product._id));
		return start ? [(product.released_at.getTime() - start.getTime()) / DAY_MS] : [];
	});

	const pending = new Map<string, { user_id: string; name: string; products: Set<string> }>();
	for (const assignment of assignments) {
		const key = String(assignment.userId);
		const entry = pending.get(key) ?? { user_id: key, name: assignment.name, products: new Set<string>() };
		for (const id of assignment.productIds) {
			if (!isScoped || scopedIds.has(String(id))) entry.products.add(String(id));
		}
		if (entry.products.size) pending.set(key, entry);
	}
	const pendingByApprover = [...pending.values()]
		.map(({ products, ...entry }) => ({ ...entry, count: products.size }))
		.sort((a, b) => b.count - a.count);

	const calendar = new Map<string, number>();
	for (const product of active) {
		const target = dueDate(product.target_date);
		if (!target) continue;
		const due = startOfDay(target);
		if (due < calendarFrom || due >= calendarTo) continue;
		calendar.set(toDay(due), (calendar.get(toDay(due)) ?? 0) + 1);
	}

	const departmentIds = [...new Set(current.map((product) => String(product.department_id)).filter(ObjectId.isValid))];
	const departments = await db
		.collection('departments')
		.find({ _id: { $in: departmentIds.map((id) => new ObjectId(id)) } }, { projection: { department_name: 1 } })
		.toArray();
	const departmentRows = departments
		.map((department) => {
			const inDepartment = current.filter((product) => String(product.department_id) === String(department._id));
			return {
				department_id: String(department._id),
				name: department.department_name as string,
				...Object.fromEntries(
					PIPELINE_STATUSES.map((status) => [status, inDepartment.filter((product) => product.status === status).length]),
				),
				total: inDepartment.length,
			};
		})
		.sort((a, b) => b.total - a.total);

	const drafts = current.filter((product) => product.status === 'draft');
	const monthOf = (date: Date) => toDay(date).slice(0, 7);

	return {
		range: { from: toDay(filters.from), to: toDay(new Date(filters.to.getTime() - DAY_MS)) },
		tiles: {
			in_progress: active.length,
			released: releasedInRange.length,
			on_time_rate: withTarget.length
				? withTarget.filter((product) => product.released_at < new Date(startOfDay(new Date(product.target_date)).getTime() + DAY_MS)).length /
					withTarget.length
				: null,
			median_days_to_release: median(daysToRelease),
			pending_approvals: pendingByApprover.reduce((sum, entry) => sum + entry.count, 0),
			overdue: overdue.length,
		},
		pipeline: Object.fromEntries(
			PIPELINE_STATUSES.map((status) => [status, current.filter((product) => product.status === status).length]),
		),
		due_calendar: {
			from: toDay(calendarFrom),
			to: toDay(new Date(calendarTo.getTime() - DAY_MS)),
			today: toDay(today),
			days: [...calendar].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
		},
		created_vs_released: months.map((month) => ({
			month,
			created: created.filter((event) => monthOf(event.occurredAt) === month).length,
			released: released.filter((product) => monthOf(product.released_at) === month).length,
		})),
		pending_by_approver: pendingByApprover,
		incomplete_tabs: COMPLETION_TABS.map((tab) => ({
			tab,
			count: drafts.filter((product) => !product[tab]?.tab_completed).length,
		})),
		draft_count: drafts.length,
		departments: departmentRows,
	};
};

export const buildDrillDownMatch = async (
	db: Db,
	filters: AnalyticsFilters,
	metric: AnalyticsMetric,
	value?: string,
): Promise<Document | null> => {
	const today = startOfDay(new Date());
	const active = { ...currentMatch(filters), status: { $in: ACTIVE_STATUSES } };

	switch (metric) {
	case 'status':
		return PIPELINE_STATUSES.includes(value as typeof PIPELINE_STATUSES[number])
			? { ...currentMatch(filters), status: value }
			: null;
	case 'in_progress':
		return active;
	case 'overdue':
		return { ...active, ...targetDateBetween(null, today) };
	case 'due': {
		const day = value && parseDay(value);
		return day ? { ...active, ...targetDateBetween(day, new Date(day.getTime() + DAY_MS)) } : null;
	}
	case 'released': {
		const month = value && parseMonth(value);
		if (value && !month) return null;
		return month ? releasedMatch(filters, ...monthWindow(month, filters)) : releasedMatch(filters, filters.from, filters.to);
	}
	case 'created': {
		const month = value && parseMonth(value);
		if (!month) return null;
		const events = await createdProductIds(db, filters, ...monthWindow(month, filters));
		return { _id: { $in: events.map((event) => event.productId) } };
	}
	case 'approver': {
		if (!value || !ObjectId.isValid(value)) return null;
		const assignments = await pendingAssignments(db, filters.workspaceId);
		const ids = assignments.filter((assignment) => String(assignment.userId) === value).flatMap((a) => a.productIds);
		return { ...scopeMatch(filters), _id: { $in: ids } };
	}
	case 'tab':
		return COMPLETION_TABS.includes(value as typeof COMPLETION_TABS[number])
			? { ...currentMatch(filters), status: 'draft', [`${value}.tab_completed`]: { $ne: true } }
			: null;
	}
};
