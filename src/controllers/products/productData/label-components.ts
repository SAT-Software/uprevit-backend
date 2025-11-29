import { APIGatewayProxyResult } from 'aws-lambda';
import { validateMissingFields, validateObjectIds, validateTab } from '../../../utils/validationUtils';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { labelComponent } from '../../../types/products/label-components';
import { ObjectId } from 'mongodb';

type LabelComponentReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: labelComponent | labelComponent[];
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
 * Handles the addition of a new label component.
 * @param {labelComponent[]} newLabelComponentsData - The new label components to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelComponentReturn} An object containing the update query, updated data, and any validation error.
 */
export function addLabelComponent(
	newLabelComponentsData: labelComponent[],
	tab: string,
	action: string,
): LabelComponentReturn {
	try {
		const isValidatedTabLabelComponents = validateTab(tab, 'label-components', action);
		if (isValidatedTabLabelComponents) throw new Error(isValidatedTabLabelComponents.body);

		if (!Array.isArray(newLabelComponentsData)) {
			throw new Error('Data for add_label_component must be an array of label components.');
		}

		const componentsWithIds = newLabelComponentsData.map(component => ({
			...component,
			_id: new ObjectId(),
		}));

		const updateQuery = { $push: { 'label_components.data': { $each: componentsWithIds } } };
		const updatedData = componentsWithIds;
		const actionLog = 'CREATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: [],
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: [],
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to add label component'),
		};
	}
}

/**
 * Handles the update of an existing label component.
 * @param {labelComponent} updatedLabelComponent - The data for the label component to update, including its id.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelComponentReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateLabelComponent(
	updatedLabelComponent: labelComponent & { id: string },
	tab: string,
	action: string,
): LabelComponentReturn {
	try {
		const isValidatedTabLabelComponents = validateTab(tab, 'label-components', action);
		if (isValidatedTabLabelComponents) throw new Error(isValidatedTabLabelComponents.body);

		const missingFieldsValidation = validateMissingFields({
			id: updatedLabelComponent.id,
			component_number: updatedLabelComponent.component_number as string,
			component_type: updatedLabelComponent.component_type as string,
			component_description: updatedLabelComponent.component_description as string,
		});
		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: updatedLabelComponent.id,
		});
		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$set: {
				'label_components.data.$[elem].image': updatedLabelComponent.image,
				'label_components.data.$[elem].dimensions': updatedLabelComponent.dimensions,
				'label_components.data.$[elem].label_type': updatedLabelComponent.label_type,
				'label_components.data.$[elem].component_number': updatedLabelComponent.component_number,
				'label_components.data.$[elem].component_type': updatedLabelComponent.component_type,
				'label_components.data.$[elem].component_description': updatedLabelComponent.component_description,
			},
			arrayFilters: [{ 'elem._id': new ObjectId(updatedLabelComponent.id) }],
		};
		const updatedData = updatedLabelComponent;
		const actionLog = 'UPDATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: {} as labelComponent,
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: {} as labelComponent,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update label component'),
		};
	}
}


/**
 * Handles the update of an existing label component.
 * @param {labelComponent} deletedLabelComponent - The data for the label component to update, including its id.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelComponentReturn} An object containing the update query, updated data, and any validation error.
 */
export function deleteLabelComponent(
	deletedLabelComponent: labelComponent & { id: string },
	tab: string,
	action: string,
): LabelComponentReturn {
	try {
		const isValidatedTabLabelComponents = validateTab(tab, 'label-components', action);
		if (isValidatedTabLabelComponents) throw new Error(isValidatedTabLabelComponents.body);

		const missingFieldsValidation = validateMissingFields({
			id: deletedLabelComponent.id,
		});

		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: deletedLabelComponent.id,
		});

		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$pull: {
				'label_components.data': { _id: new ObjectId(deletedLabelComponent.id) },
			},
		};

		const actionLog = 'DELETE';

		return { updateQuery, updatedData: deletedLabelComponent, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: {} as labelComponent,
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: {} as labelComponent,
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update label component'),
		};
	}
}

/**
 * Handles the update of compliance information tab completion status.
 * @param {UpdateComplianceTabCompletionData} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelComponentReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateLabelComponentTabCompletion(
	inputData: { tab_completed: boolean },
	tab: string,
	action: string,
): Omit<LabelComponentReturn, 'updatedData'> & { updatedData: { tab_completed: boolean } } {
	try {
		const isValidatedTabLabelComponent = validateTab(tab, 'label-components', action);
		if (isValidatedTabLabelComponent) throw new Error(isValidatedTabLabelComponent.body);

		if (typeof inputData.tab_completed !== 'boolean') throw new Error('tab_completed must be a boolean value.');

		const updateQuery = { $set: { 'label_components.tab_completed': inputData.tab_completed } };
		const updatedData = { tab_completed: inputData.tab_completed };
		const actionLog = 'UPDATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { tab_completed: false },
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { tab_completed: false },
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update label component tab completion'),
		};
	}
}