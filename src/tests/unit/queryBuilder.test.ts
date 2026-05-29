import { ObjectId } from 'mongodb';
import { describe, expect, it } from '@jest/globals';
import { buildAggregationPipeline, buildExportPipeline } from '../../utils/reports/queryBuilder';

describe('buildExportPipeline', () => {
	it('projects label tag completion state for report exports', () => {
		const pipeline = buildExportPipeline({
			workspaceId: new ObjectId().toString(),
			conditions: [],
		}, new ObjectId(), 1000);

		expect(pipeline[3]).toEqual({
			$project: expect.objectContaining({
				'label_tags.tab_completed': 1,
			}),
		});
	});

	it('filters report exports by Product Information device class', () => {
		const pipeline = buildExportPipeline({
			workspaceId: new ObjectId().toString(),
			conditions: [{
				id: 'class-filter',
				tab: 'product_information',
				field: 'class_of_device',
				operator: 'equals',
				value: 'EU MDR - Class IIa',
			}],
		}, new ObjectId(), 1000);

		expect(pipeline[1]).toEqual({
			$match: {
				$and: [{
					'product_information.data.class_of_device': 'EU MDR - Class IIa',
				}],
			},
		});
	});
});

describe('buildAggregationPipeline', () => {
	it('filters reports by Product Information Basic UDI-DI', () => {
		const pipeline = buildAggregationPipeline({
			workspaceId: new ObjectId().toString(),
			conditions: [{
				id: 'udi-filter',
				tab: 'product_information',
				field: 'basic_udi_di',
				operator: 'contains',
				value: 'BUDI-123',
			}],
			pagination: {
				page: 1,
				limit: 10,
			},
		}, new ObjectId());

		expect(pipeline[1]).toEqual({
			$match: {
				$and: [{
					'product_information.data.basic_udi_di': {
						$regex: 'BUDI-123',
						$options: 'i',
					},
				}],
			},
		});
	});
});
