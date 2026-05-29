import { describe, expect, it } from '@jest/globals';
import { updateLabelComponent } from '../../controllers/products/productData/label-components';

describe('updateLabelComponent', () => {
	it('does not overwrite component_description when it is omitted', () => {
		const result = updateLabelComponent(
			{
				id: '507f1f77bcf86cd799439011',
				component_number: '1',
				component_type: 'Primary',
			},
			'label-components',
			'update_label_component',
		);

		expect(result.error).toBeNull();
		expect(result.updateQuery).toEqual({
			$set: {
				'label_components.data.$[elem].image': undefined,
				'label_components.data.$[elem].dimensions': undefined,
				'label_components.data.$[elem].label_type': undefined,
				'label_components.data.$[elem].component_number': '1',
				'label_components.data.$[elem].component_type': 'Primary',
			},
			arrayFilters: [{ 'elem._id': expect.anything() }],
		});
		expect((result.updateQuery as { $set: Record<string, unknown> }).$set).not.toHaveProperty(
			'label_components.data.$[elem].component_description',
		);
	});

	it('updates component_description when it is provided', () => {
		const result = updateLabelComponent(
			{
				id: '507f1f77bcf86cd799439011',
				component_number: '1',
				component_type: 'Primary',
				component_description: 'Updated description',
			},
			'label-components',
			'update_label_component',
		);

		expect(result.error).toBeNull();
		expect(
			(result.updateQuery as { $set: Record<string, unknown> }).$set[
				'label_components.data.$[elem].component_description'
			],
		).toBe('Updated description');
	});
});
