import { ObjectId } from 'mongodb';
import { describe, expect, it } from '@jest/globals';

process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
process.env.UPLOADS_BUCKET = process.env.UPLOADS_BUCKET ?? 'test-uploads';
process.env.EXPORTS_BUCKET = process.env.EXPORTS_BUCKET ?? 'test-exports';

const { buildProductListPipeline, buildProductSearchOr } = require('../../utils/productListPipeline');
const { productSummaryProjection } = require('../../utils/productLifecycle');

const baseInput = {
	match: { workspace_id: new ObjectId() },
	isArchiveOnlyStatus: false,
	filters: [],
	sort: 'product_name',
	order: 'asc',
	skip: 0,
	limit: 10,
};

describe('productListPipeline', () => {
	it('escapes regex metacharacters in the search term', () => {
		const result = buildProductSearchOr('a.(b)');
		expect(result.or[0]).toEqual({ product_name: { $regex: 'a\\.\\(b\\)', $options: 'i' } });
	});

	it('rejects a search term over the length cap', () => {
		const result = buildProductSearchOr('x'.repeat(201));
		expect(result.error.statusCode).toBe(400);
	});

	it('projects the summary and ends in one facet', () => {
		const { pipeline } = buildProductListPipeline(baseInput);
		expect(pipeline[1]).toEqual({ $project: productSummaryProjection });
		const facet = pipeline[pipeline.length - 1].$facet;
		expect(facet.rows.map((stage: Record<string, unknown>) => Object.keys(stage)[0])).toEqual(['$sort', '$skip', '$limit']);
		expect(facet.total).toEqual([{ $count: 'total' }]);
	});

	it('returns an error instead of a pipeline for an invalid filter', () => {
		const result = buildProductListPipeline({
			...baseInput,
			filters: [{ field: 'not_allowed', operator: 'eq', value: 'x' }],
		});
		expect(result.error).toBeDefined();
		expect(result.pipeline).toBeUndefined();
	});

	it('keeps the caller match as the first stage', () => {
		const id = new ObjectId();
		const match = { _id: { $in: [id] } };
		const { pipeline } = buildProductListPipeline({ ...baseInput, match });
		expect(pipeline[0]).toEqual({ $match: match });
	});
});
