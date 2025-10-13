import { APIGatewayProxyResult } from 'aws-lambda';
import { validateTab, validateMissingFields, validateObjectIds } from '../../../utils/validationUtils';
import {
	AddComplianceInfoData,
	UpdateComplianceInfoData,
	DeleteComplianceStandardData,
	UpdateComplianceTabCompletionData,
} from '../../../types/products/compliance-info';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { ObjectId } from 'mongodb';

type ComplianceStandardReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: AddComplianceInfoData | UpdateComplianceInfoData | DeleteComplianceStandardData | UpdateComplianceTabCompletionData;
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
 * Handles the addition of new compliance standards.
 * @param {AddComplianceInfoData} newComplianceStandards - The array of new compliance standard items to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ComplianceStandardReturn} An object containing the update query, updated data, and any validation error.
 */
export function addComplianceStandard(
	newComplianceStandards: AddComplianceInfoData,
	tab: string,
	action: string,
): ComplianceStandardReturn {
	try {
		const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
		if (isValidatedTabComplianceInfo) throw new Error(isValidatedTabComplianceInfo.body);;

		if (!Array.isArray(newComplianceStandards) || newComplianceStandards.length === 0)
			throw new Error('Data for adding compliance standards must be a non-empty array.');

		for (const standard of newComplianceStandards) {
			if (!standard.standard || !standard.standard_description)
				throw new Error('Both standard and standard_description are required for each compliance standard');
		}

		const standardsWithIds = newComplianceStandards.map(standard => ({
			...standard,
			_id: new ObjectId(),
		}));

		const updateQuery = {
			$push: {
				'compliance_information.data': { $each: standardsWithIds },
			},
		};
		const updatedData = standardsWithIds.map(standard => ({
			...standard,
			_id: standard._id.toString(),
		}));
		const actionLog = 'CREATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: {} as AddComplianceInfoData,
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: {} as AddComplianceInfoData,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to add compliance standards'),
		};
	}
}

/**
 * Handles the update of an existing compliance standard.
 * @param {UpdateComplianceInfoData} updatedComplianceStandard - The data for the compliance standard to update, including its id.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ComplianceStandardReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateComplianceStandard(
	updatedComplianceStandard: UpdateComplianceInfoData,
	tab: string,
	action: string,
): ComplianceStandardReturn {
	try {
		const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
		if (isValidatedTabComplianceInfo) throw new Error(isValidatedTabComplianceInfo.body);

		const missingFieldsValidation = validateMissingFields({
			id: updatedComplianceStandard.id,
			standard: updatedComplianceStandard.standard,
			standard_description: updatedComplianceStandard.standard_description,
		});

		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: updatedComplianceStandard.id,
		});

		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$set: {
				'compliance_information.data.$[elem].standard': updatedComplianceStandard.standard,
				'compliance_information.data.$[elem].standard_description':
					updatedComplianceStandard.standard_description,
			},
			arrayFilters: [{ 'elem._id': new ObjectId(updatedComplianceStandard.id) }],
		};

		const updatedData = updatedComplianceStandard;
		const actionLog = 'UPDATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: {} as UpdateComplianceInfoData,
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: {} as UpdateComplianceInfoData,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update compliance standards'),
		};
	}
}

/**
 * Handles the deletion of an existing compliance standard.
 * @param {DeleteComplianceStandardData} standardId - The ID of the compliance standard to delete.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ComplianceStandardReturn} An object containing the update query and any validation error.
 */
export function deleteComplianceStandard(
	standardId: DeleteComplianceStandardData,
	tab: string,
	action: string,
): ComplianceStandardReturn {
	try {
		const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
		if (isValidatedTabComplianceInfo) throw new Error(isValidatedTabComplianceInfo.body);

		const missingFieldsValidation = validateMissingFields({
			id: standardId.id,
		});

		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: standardId.id,
		});

		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$pull: {
				'compliance_information.data': { _id: new ObjectId(standardId.id) },
			},
		};

		const actionLog = 'DELETE';

		return { updateQuery, updatedData: {} as DeleteComplianceStandardData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: null as unknown as DeleteComplianceStandardData,
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: null as unknown as DeleteComplianceStandardData,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to delete compliance standard'),
		};
	}
}

/**
 * Handles the update of compliance information tab completion status.
 * @param {UpdateComplianceTabCompletionData} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {ComplianceStandardReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateComplianceTabCompletion(
	inputData: UpdateComplianceTabCompletionData,
	tab: string,
	action: string,
): ComplianceStandardReturn {
	try {
		const isValidatedTabComplianceInfo = validateTab(tab, 'compliance-information', action);
		if (isValidatedTabComplianceInfo) throw new Error(isValidatedTabComplianceInfo.body);
	
		if (typeof inputData.tab_completed !== 'boolean') throw new Error('tab_completed must be a boolean value.');
	
		const updateQuery = { $set: { 'compliance_information.tab_completed': inputData.tab_completed } };
		const updatedData = { tab_completed: inputData.tab_completed };
		const actionLog = 'UPDATE';
	
		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error) return { updateQuery: {}, updatedData: {} as UpdateComplianceTabCompletionData, actionLog: '', error: ResponseWrapper.badRequest(error.message) };
		return {
			updateQuery: {},
			updatedData: {} as UpdateComplianceTabCompletionData,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update compliance tab completion'),
		};
	}
}