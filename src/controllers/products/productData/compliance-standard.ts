import { APIGatewayProxyResult } from 'aws-lambda';
import { validateTab, validateMissingFields, validateObjectIds } from '../../../utils/validationUtils';
import { AddComplianceInfo, UpdateComplianceInfo } from '../../../types/products/compliance-info';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { ObjectId } from 'mongodb';

type AddComplianceStandardReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: AddComplianceInfo;
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
 * Handles the addition of new compliance standards.
 * @param {AddComplianceInfo} newComplianceStandards - The array of new compliance standard items to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {AddComplianceStandardReturn} An object containing the update query, updated data, and any validation error.
 */
export function addComplianceStandard(
	newComplianceStandards: AddComplianceInfo,
	tab: string,
	action: string,
): AddComplianceStandardReturn {
	const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
	if (isValidatedTabComplianceInfo)
		return {
			updateQuery: {},
			updatedData: [],
			actionLog: '',
			error: isValidatedTabComplianceInfo,
		};

	// Validate input array
	if (!Array.isArray(newComplianceStandards) || newComplianceStandards.length === 0) {
		return {
			updateQuery: {},
			updatedData: [],
			actionLog: '',
			error: ResponseWrapper.badRequest('Compliance standards array is required and cannot be empty'),
		};
	}

	// Validate each compliance standard item
	for (const standard of newComplianceStandards) {
		if (!standard.standard || !standard.standard_description) {
			return {
				updateQuery: {},
				updatedData: [],
				actionLog: '',
				error: ResponseWrapper.badRequest('Both standard and standard_description are required for each compliance standard'),
			};
		}
	}

	
	const standardsWithIds = newComplianceStandards.map(standard => ({
		...standard,
		_id: new ObjectId()
	}));

	const updateQuery = {
		$push: {
			'compliance_information.data': { $each: standardsWithIds },
		},
	};
	const updatedData = standardsWithIds.map(standard => ({
		...standard,
		_id: standard._id.toString()
	}));
	const actionLog = 'CREATE';

	return { updateQuery, updatedData, actionLog, error: null };
}

type UpdateComplianceStandardReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: UpdateComplianceInfo;
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
 * Handles the update of an existing compliance standard.
 * @param {UpdateComplianceInfo} updatedComplianceStandard - The data for the compliance standard to update, including its id.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {UpdateComplianceStandardReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateComplianceStandard(
	updatedComplianceStandard: UpdateComplianceInfo,
	tab: string,
	action: string,
): UpdateComplianceStandardReturn {
	const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
	if (isValidatedTabComplianceInfo)
		return {
			updateQuery: {},
			updatedData: { id: '', standard: '', standard_description: '' },
			actionLog: '',
			error: isValidatedTabComplianceInfo,
		};

	// Validate required fields
	const missingFieldsValidation = validateMissingFields({
		'id': updatedComplianceStandard.id,
		'standard': updatedComplianceStandard.standard,
		'standard_description': updatedComplianceStandard.standard_description,
	});
	
	if (missingFieldsValidation) {
		return {
			updateQuery: {},
			updatedData: { id: '', standard: '', standard_description: '' },
			actionLog: '',
			error: missingFieldsValidation,
		};
	}

	// Validate ObjectId format
	const objectIdValidation = validateObjectIds({
		'id': updatedComplianceStandard.id,
	});
	
	if (objectIdValidation) {
		return {
			updateQuery: {},
			updatedData: { id: '', standard: '', standard_description: '' },
			actionLog: '',
			error: objectIdValidation,
		};
	}

	const updateQuery = {
		$set: {
			'compliance_information.data.$[elem].standard': updatedComplianceStandard.standard,
			'compliance_information.data.$[elem].standard_description': updatedComplianceStandard.standard_description,
		},
		arrayFilters: [
			{ 'elem._id': new ObjectId(updatedComplianceStandard.id) }
		],
	};

	const updatedData = updatedComplianceStandard;
	const actionLog = 'UPDATE';

	return { updateQuery, updatedData, actionLog, error: null };
}

type DeleteComplianceStandardReturn = {
	updateQuery: Record<string, unknown>;
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
	* Handles the deletion of an existing compliance standard.
	* @param {string} standardId - The ID of the compliance standard to delete.
	* @param {string} tab - The current tab being updated.
	* @param {string} action - The action being performed.
	* @return {DeleteComplianceStandardReturn} An object containing the update query and any validation error.
	*/
export function deleteComplianceStandard(
	standardId: string,
	tab: string,
	action: string,
): DeleteComplianceStandardReturn {
	const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
	if (isValidatedTabComplianceInfo)
		return {
			updateQuery: {},
			actionLog: '',
			error: isValidatedTabComplianceInfo,
		};

	// Validate required field
	const missingFieldsValidation = validateMissingFields({
		'id': standardId,
	});
	
	if (missingFieldsValidation) {
		return {
			updateQuery: {},
			actionLog: '',
			error: missingFieldsValidation,
		};
	}

	// Validate ObjectId format
	const objectIdValidation = validateObjectIds({
		'id': standardId,
	});
	
	if (objectIdValidation) {
		return {
			updateQuery: {},
			actionLog: '',
			error: objectIdValidation,
		};
	}

	const updateQuery = {
		$pull: {
			'compliance_information.data': { _id: new ObjectId(standardId) }
		},
	};

	const actionLog = 'DELETE';

	return { updateQuery, actionLog, error: null };
}

type UpdateComplianceTabCompletionReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: { tab_completed: boolean };
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
	* Handles the update of compliance information tab completion status.
	* @param {{ tab_completed: boolean }} inputData - The data object containing the tab completion status.
	* @param {string} tab - The current tab being updated.
	* @param {string} action - The action being performed.
	* @return {UpdateComplianceTabCompletionReturn} An object containing the update query, updated data, and any validation error.
	*/
export function updateComplianceTabCompletion(
	inputData: { tab_completed: boolean },
	tab: string,
	action: string,
): UpdateComplianceTabCompletionReturn {
	const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
	if (isValidatedTabComplianceInfo)
		return {
			updateQuery: {},
			updatedData: { tab_completed: inputData.tab_completed },
			actionLog: '',
			error: isValidatedTabComplianceInfo,
		};

	if (typeof inputData.tab_completed !== 'boolean') {
		return {
			updateQuery: {},
			updatedData: { tab_completed: inputData.tab_completed },
			actionLog: '',
			error: ResponseWrapper.badRequest('tab_completed must be a boolean value'),
		};
	}

	const updateQuery = { $set: { 'compliance_information.tab_completed': inputData.tab_completed } };
	const updatedData = { tab_completed: inputData.tab_completed };
	const actionLog = 'UPDATE';

	return { updateQuery, updatedData, actionLog, error: null };
}