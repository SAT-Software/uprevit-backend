import { describe, expect, it } from '@jest/globals';
import { buildListFiltersMatch, parseListQuery } from '../../utils/listQuery';

const allowedFields = {
	name: { path: 'name', type: 'text' as const },
	count: { path: 'count', type: 'number' as const },
	actionAt: { path: 'actionAt', type: 'date' as const },
};

describe('parseListQuery', () => {
	it('parses pagination, sort order, and encoded filters', () => {
		const result = parseListQuery({
			query: {
				page: '2',
				limit: '10',
				sort: 'name',
				order: 'desc',
				filters: JSON.stringify([{ field: 'name', operator: 'contains', value: 'pump' }]),
			},
			allowedSortFields: ['name', 'actionAt'],
			defaultSort: 'name',
		});

		expect(result.error).toBeUndefined();
		expect(result.value).toEqual({
			page: 2,
			limit: 10,
			sort: 'name',
			order: 'desc',
			skip: 10,
			filters: [{ field: 'name', operator: 'contains', value: 'pump' }],
		});
	});

	it('rejects invalid direct API params', () => {
		const result = parseListQuery({
			query: {
				page: '0',
				sort: 'unknown',
			},
			allowedSortFields: ['name'],
			defaultSort: 'name',
		});

		expect(result.error?.statusCode).toBe(400);
	});
});

describe('buildListFiltersMatch', () => {
	it('builds AND filters with escaped contains and numeric comparison', () => {
		const result = buildListFiltersMatch([
			{ field: 'name', operator: 'contains', value: 'pump.1' },
			{ field: 'count', operator: 'gte', value: '5' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			$and: [
				{ name: { $regex: 'pump\\.1', $options: 'i' } },
				{ count: { $gte: 5 } },
			],
		});
	});

	it('turns date-only equality into a whole UTC day range', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'eq', value: '2026-05-18' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			actionAt: {
				$gte: new Date('2026-05-18T00:00:00.000Z'),
				$lt: new Date('2026-05-19T00:00:00.000Z'),
			},
		});
	});

	it('turns date-only inequality into outside the whole UTC day range', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'neq', value: '2026-05-18' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			$or: [
				{ actionAt: { $lt: new Date('2026-05-18T00:00:00.000Z') } },
				{ actionAt: { $gte: new Date('2026-05-19T00:00:00.000Z') } },
			],
		});
	});

	it('uses the beginning of the selected date for date-only greater than or equal filters', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'gte', value: '2026-02-15' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			actionAt: { $gte: new Date('2026-02-15T00:00:00.000Z') },
		});
	});

	it('uses the next day for date-only greater than filters', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'gt', value: '2026-02-15' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			actionAt: { $gte: new Date('2026-02-16T00:00:00.000Z') },
		});
	});

	it('uses the beginning of the selected date for date-only less than filters', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'lt', value: '2026-02-15' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			actionAt: { $lt: new Date('2026-02-15T00:00:00.000Z') },
		});
	});

	it('uses the next day for date-only less than or equal filters', () => {
		const result = buildListFiltersMatch([
			{ field: 'actionAt', operator: 'lte', value: '2026-02-15' },
		], allowedFields);

		expect(result.error).toBeUndefined();
		expect(result.match).toEqual({
			actionAt: { $lt: new Date('2026-02-16T00:00:00.000Z') },
		});
	});

	it('rejects non-string values for text fields', () => {
		const result = buildListFiltersMatch([
			{ field: 'name', operator: 'eq', value: 42 },
		], allowedFields);

		expect(result.error?.statusCode).toBe(400);
		expect(result.match).toBeUndefined();
	});
});
