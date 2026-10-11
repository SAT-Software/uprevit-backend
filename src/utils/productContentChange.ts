import { isDeepStrictEqual } from 'util';
import type { Product } from '../models/product';

const REVIEWED_FIELDS = ['product_name', 'product_plan_number', 'product_description'] as const;

const REVIEWED_TABS = [
	'product_information',
	'compliance_information',
	'languages_information',
	'label_components',
	'symbols_graphics',
	'product_data',
	'operational_parameters',
	'label_tags',
] as const;

/** Planning metadata stored inside `product_information.data` that approvers are not notified about. */
const PRODUCT_INFORMATION_PLANNING_FIELDS = ['target_date', 'actual_completion_date'];

/** Workbook tabs get a new `data._id` on every save, even when the workbook is unchanged. */
const WORKBOOK_TABS = ['product_data', 'operational_parameters'] as const;

const withoutKeys = (value: unknown, keys: string[]) => {
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
};

/**
 * Drops null and undefined object values, so a field saved as null matches a field that was never set.
 * @param {unknown} value Stored value
 * @return {unknown} The value without empty fields
 */
const withoutEmptyFields = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(withoutEmptyFields);
	if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
	return Object.fromEntries(Object.entries(value)
		.filter(([, field]) => field !== null && field !== undefined)
		.map(([key, field]) => [key, withoutEmptyFields(field)]));
};

/**
 * The reviewed Product content: name, plan number, description and the 8 tabs, without tab-completed flags,
 * target dates or completion dates.
 * @param {Product} product Product version
 * @return {Object} The content an approver reviews
 */
const reviewedContent = (product: Product) => withoutEmptyFields({
	...Object.fromEntries(REVIEWED_FIELDS.map((field) => [field, product[field]])),
	...Object.fromEntries(REVIEWED_TABS.map((tab) => [tab, withoutKeys(product[tab], ['tab_completed'])])),
	...Object.fromEntries(WORKBOOK_TABS.map((tab) => [tab, {
		...withoutKeys(product[tab], ['tab_completed']) as Record<string, unknown>,
		data: withoutKeys(product[tab]?.data, ['_id']),
	}])),
	product_information: {
		...withoutKeys(product.product_information, ['tab_completed']) as Record<string, unknown>,
		data: withoutKeys(product.product_information?.data, PRODUCT_INFORMATION_PLANNING_FIELDS),
	},
});

/**
 * Whether a save changed reviewed Product content, the only kind of change that bumps `content_revision`.
 * @param {Product} before Version before the save
 * @param {Product} after Version after the save
 * @return {boolean} True when reviewed content differs
 */
export const didReviewedContentChange = (before: Product, after: Product) =>
	!isDeepStrictEqual(reviewedContent(before), reviewedContent(after));
