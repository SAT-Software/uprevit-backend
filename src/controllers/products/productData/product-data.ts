import { APIGatewayProxyResult } from 'aws-lambda';
import { ProductData } from '../../../types/products/product-data';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { validateTab } from '../../../utils/validationUtils';
import { ObjectId } from 'mongodb';

type ProductDataReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: ProductData;
	error: APIGatewayProxyResult | null;
};

/**
 * @param {ProductData} newProductData - The data for the product data to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ProductDataReturn} An object containing the update query and updated data.
 */
export function addProductData(
	newProductData: ProductData,
	tab: string,
	action: string,
): ProductDataReturn {
	try {
		const isValidatedTab = validateTab(tab, 'product-specifications', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (!newProductData.workbook_data || typeof newProductData.workbook_data !== 'object') {
			throw new Error('workbook_data must be a non-empty object.');
		}

		const newProductDataWithId = {
			...newProductData,
			_id: new ObjectId(),
		}

		const updateQuery = { $set: { 'product_data.data': newProductDataWithId } };
		const updatedData = newProductDataWithId;

		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) {
			return {
				updateQuery: {},
				updatedData: {},
				error: ResponseWrapper.badRequest(error.message),
			};
		}

		return {
			updateQuery: {},
			updatedData: {},
			error: ResponseWrapper.internalServerError('Failed to add product data'),
		};
	}
}

/**
 * @param {ProductData} updatedProductData - The updated data for the product data.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ProductDataReturn} An object containing the update query and updated data.
 */
export function updateProductData(
	updatedProductData: ProductData,
	tab: string,
	action: string,
): ProductDataReturn {
	try {
		const isValidatedTab = validateTab(tab, 'product-specifications', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (!updatedProductData.workbook_data || typeof updatedProductData.workbook_data !== 'object') {
			throw new Error('workbook_data must be a non-empty object.');
		}


		const updateQuery = { $set: { 'product_data.data': updatedProductData.workbook_data } };
		const updatedData = updatedProductData;

		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) {
			return {
				updateQuery: {},
				updatedData: {} as ProductData,
				error: ResponseWrapper.badRequest(error.message),
			};
		}

		return {
			updateQuery: {},
			updatedData: {} as ProductData,
			error: ResponseWrapper.internalServerError('Failed to update product data'),
		};
	}
}


/**
	* Handles the deletion of product data.
	* @param {string} tab - The current tab being updated.
	* @param {string} action - The action being performed.
	* @return {ProductDataReturn} An object containing the update query and any validation error.
	*/
export function deleteProductData(
	tab: string,
	action: string,
): ProductDataReturn {
	try {
		const isValidatedTab = validateTab(tab, 'product-specifications', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		const updateQuery = {
			$set: { 'product_data.data': {} },
		};

		return { updateQuery, updatedData: {}, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: {},
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: {},
			error: ResponseWrapper.internalServerError('Failed to delete product data'),
		};
	}
}

/**
 * Handles the update of product data tab completion status.
 * @param { ProductData } inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ProductDataReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateProductDataTabCompletion(
	inputData: ProductData & { tab_completed: boolean },
	tab: string,
	action: string,
): Omit<ProductDataReturn, 'updatedData'> & { updatedData: { tab_completed: boolean } } {
	try {
		const isValidatedTab = validateTab(tab, 'product-specifications', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (typeof inputData.tab_completed !== 'boolean') {
			throw new Error('tab_completed must be a boolean value.');
		}

		const updateQuery = { $set: { 'product_data.tab_completed': inputData.tab_completed } };
		const updatedData = { tab_completed: inputData.tab_completed };

		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) {
			return {
				updateQuery: {},
				updatedData: { tab_completed: false },
				error: ResponseWrapper.badRequest(error.message),
			};
		}
		return {
			updateQuery: {},
			updatedData: { tab_completed: false },
			error: ResponseWrapper.internalServerError('Failed to update product data tab completion'),
		};
	}
}
