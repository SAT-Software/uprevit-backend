import { ResponseWrapper } from './responseWrapper';
import { validateTab } from './validationUtils';

/** The seven Product Version tabs that count towards completion, in display order. */
export const PRODUCT_TABS = [
	{
		field: 'product_information',
		slug: 'product-information',
		label: 'Product information',
		completionAction: 'update_product_information_completion',
		completionEvent: 'product.product_information.completion.updated',
	},
	{
		field: 'compliance_information',
		slug: 'compliance-information',
		label: 'Compliance',
		completionAction: 'update_compliance_tab_completion',
		completionEvent: 'product.compliance_information.completion.updated',
	},
	{
		field: 'label_components',
		slug: 'label-components',
		label: 'Label components',
		completionAction: 'update_label_component_tab_completion',
		completionEvent: 'product.label_components.completion.updated',
	},
	{
		field: 'symbols_graphics',
		slug: 'symbols-graphics',
		label: 'Symbols & graphics',
		completionAction: 'update_symbols_graphics_tab_completion',
		completionEvent: 'product.symbol_graphics.completion.updated',
	},
	{
		field: 'product_data',
		slug: 'product-specifications',
		label: 'Product specifications',
		completionAction: 'update_product_data_tab_completion',
		completionEvent: 'product.product_specifications.completion.updated',
	},
	{
		field: 'operational_parameters',
		slug: 'operational-parameters',
		label: 'Operational parameters',
		completionAction: 'update_operational_parameters_tab_completion',
		completionEvent: 'product.operational_parameters.completion.updated',
	},
	{
		field: 'label_tags',
		slug: 'label-tags',
		label: 'Label tags',
		completionAction: 'update_label_tags_tab_completion',
		completionEvent: 'product.label_tags.completion.updated',
	},
] as const;

export type ProductTab = typeof PRODUCT_TABS[number];

export const getTabByCompletionAction = (action: string): ProductTab | undefined =>
	PRODUCT_TABS.find((tab) => tab.completionAction === action);

/**
 * Builds the update that marks one tab complete or incomplete.
 * @param {ProductTab} productTab Tab the action belongs to
 * @param {unknown} inputData Request data with `tab_completed`
 * @param {string} tab Tab slug sent with the request
 * @return {object} Mongo update and response data, or a 400 response
 */
export const buildTabCompletionUpdate = (productTab: ProductTab, inputData: unknown, tab: string) => {
	const tabError = validateTab(tab, productTab.slug, productTab.completionAction);
	if (tabError) return { error: tabError };

	const tabCompleted = (inputData as { tab_completed?: unknown } | undefined)?.tab_completed;
	if (typeof tabCompleted !== 'boolean') {
		return { error: ResponseWrapper.badRequest('tab_completed must be a boolean value.') };
	}

	return {
		error: null,
		updateQuery: { $set: { [`${productTab.field}.tab_completed`]: tabCompleted } },
		updatedData: { tab_completed: tabCompleted },
	};
};
