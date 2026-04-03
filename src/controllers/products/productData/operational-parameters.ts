import { APIGatewayProxyResult } from 'aws-lambda';
import { OperationalParameters } from '../../../types/products/operational-parameters';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { validateTab } from '../../../utils/validationUtils';
import { ObjectId } from 'mongodb';

type OperationalParametersReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: OperationalParameters;
	error: APIGatewayProxyResult | null;
};

/**
 * @param {OperationalParameters} newOperationalParameters - The data for the operational parameters to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {OperationalParametersReturn} An object containing the update query and updated data.
 */
export function addOperationalParameters(
	newOperationalParameters: OperationalParameters,
	tab: string,
	action: string,
): OperationalParametersReturn {
	try {
		const isValidatedTab = validateTab(tab, 'operational-parameters', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (!newOperationalParameters.workbook_data || typeof newOperationalParameters.workbook_data !== 'object') {
			throw new Error('workbook_data must be a non-empty object.');
		}

		const newOperationalParametersWithId = {
			...newOperationalParameters,
			_id: new ObjectId(),
		}

		const updateQuery = { $set: { 'operational_parameters.data': newOperationalParametersWithId } };
		const updatedData = newOperationalParametersWithId;

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
			error: ResponseWrapper.internalServerError('Failed to add operational parameters'),
		};
	}
}

/**
 * @param {OperationalParameters} updatedOperationalParameters - The updated data for the operational parameters.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {OperationalParametersReturn} An object containing the update query and updated data.
 */
export function updateOperationalParameters(
	updatedOperationalParameters: OperationalParameters,
	tab: string,
	action: string,
): OperationalParametersReturn {
	try {
		const isValidatedTab = validateTab(tab, 'operational-parameters', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (!updatedOperationalParameters.workbook_data || typeof updatedOperationalParameters.workbook_data !== 'object') {
			throw new Error('workbook_data must be a non-empty object.');
		}


		const updateQuery = { $set: { 'operational_parameters.data': updatedOperationalParameters.workbook_data } };
		const updatedData = updatedOperationalParameters;

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
			error: ResponseWrapper.internalServerError('Failed to update operational parameters'),
		};
	}
}


/**
	* Handles the deletion of operational parameters.
	* @param {string} tab - The current tab being updated.
	* @param {string} action - The action being performed.
	* @return {OperationalParametersReturn} An object containing the update query and any validation error.
	*/
export function deleteOperationalParameters(
	tab: string,
	action: string,
): OperationalParametersReturn {
	try {
		const isValidatedTab = validateTab(tab, 'operational-parameters', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		const updateQuery = {
			$set: { 'operational_parameters.data': {} },
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
			error: ResponseWrapper.internalServerError('Failed to delete operational parameters'),
		};
	}
}

/**
 * Handles the update of operational parameters tab completion status.
 * @param { OperationalParameters } inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {OperationalParametersReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateOperationalParametersTabCompletion(
	inputData: OperationalParameters & { tab_completed: boolean },
	tab: string,
	action: string,
): Omit<OperationalParametersReturn, 'updatedData'> & { updatedData: { tab_completed: boolean } } {
	try {
		const isValidatedTab = validateTab(tab, 'operational-parameters', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (typeof inputData.tab_completed !== 'boolean') {
			throw new Error('tab_completed must be a boolean value.');
		}

		const updateQuery = { $set: { 'operational_parameters.tab_completed': inputData.tab_completed } };
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
			error: ResponseWrapper.internalServerError('Failed to update operational parameters tab completion'),
		};
	}
}
