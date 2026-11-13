import { describe, expect, it } from '@jest/globals';
import { buildTabCompletionUpdate, getTabByCompletionAction } from '../../utils/productTabs';

describe('product tabs', () => {
	const labelTags = getTabByCompletionAction('update_label_tags_tab_completion')!;

	it('finds the tab for each completion action', () => {
		expect(getTabByCompletionAction('update_product_data_tab_completion')?.field).toBe('product_data');
		expect(getTabByCompletionAction('update_label_tags')).toBeUndefined();
	});

	it('builds the completion update for the matching tab', () => {
		expect(buildTabCompletionUpdate(labelTags, { tab_completed: true }, 'label-tags')).toEqual({
			error: null,
			updateQuery: { $set: { 'label_tags.tab_completed': true } },
			updatedData: { tab_completed: true },
		});
	});

	it('rejects a mismatched tab or a non-boolean flag', () => {
		const wrongTab = buildTabCompletionUpdate(labelTags, { tab_completed: true }, 'product-information');
		expect(wrongTab.error?.statusCode).toBe(400);
		expect(JSON.parse(wrongTab.error!.body).message).toBe('Action update_label_tags_tab_completion must be used with tab label-tags');

		expect(buildTabCompletionUpdate(labelTags, { tab_completed: 'yes' }, 'label-tags').error?.statusCode).toBe(400);
	});
});
