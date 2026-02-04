import { APIGatewayProxyResult } from "aws-lambda";
import { LabelTag, LegendItem } from "../../../types/products/label-tags";
import { ResponseWrapper } from "../../../utils/responseWrapper";
import { validateAllObjectIds, validateMissingFields, validateObjectIds, validateTab } from "../../../utils/validationUtils";
import { ObjectId } from "mongodb";

type LabelTagReturn = {
    updateQuery: Record<string, unknown>;
    updatedData: LabelTag | LabelTag[];
    actionLog: string;
    error: APIGatewayProxyResult | null;
}

/**
 * @param {LabelTag} newLabelTag - The data for the label tag to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelTagReturn} An object containing the update query and updated data.
 */
export function addLabelTag(
	newLabelTag: LabelTag[],
	tab: string,
	action: string,
): LabelTagReturn {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (!Array.isArray(newLabelTag)) {
			throw new Error('Data for addLabelTag must be an array of label tags.');
		}

		const componentsWithIds = newLabelTag.map(label => ({
			...label,
			_id: new ObjectId(),
		}));

		const updateQuery = { $push: { 'label_tags.data': { $each: componentsWithIds } } }
		const updatedData = componentsWithIds;
		const actionLog = 'CREATE';

		return { updateQuery, updatedData, actionLog, error: null }
	} catch (error) {
		if (error instanceof Error) return {
			updateQuery: {},
			updatedData: [],
			actionLog: '',
			error: ResponseWrapper.badRequest(error.message),
		}

		return {
			updateQuery: {},
			updatedData: [],
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to add label tag'),
		}
	}
}

/**
 * @param {LabelTag} updatedLabelTag - The updated data for the label tag.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelTagReturn} An object containing the update query and updated data.
 */
export function updateLabelTag(
	updatedLabelTag: Required<LabelTag>,
	tab: string,
	action: string,
): LabelTagReturn {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);
        
		const missingFieldsValidation = validateMissingFields({
			id: updatedLabelTag.id,
			name: updatedLabelTag.name,
			description: updatedLabelTag.description,
			type: updatedLabelTag.type,
		})
		if(missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation =validateAllObjectIds({id: updatedLabelTag.id})
		if(objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {$set: {
			'label_tags.data.$[elem].name': updatedLabelTag.name,
			'label_tags.data.$[elem].description': updatedLabelTag.description,
			'label_tags.data.$[elem].type': updatedLabelTag.type,
			'label_tags.data.$[elem].image': updatedLabelTag.image,
		}, arrayFilters: [{'elem._id': new ObjectId(updatedLabelTag.id!)}]}

		const updatedData = updatedLabelTag;
		const actionLog = 'UPDATE';

		return {updateQuery, updatedData, actionLog, error: null}
	} catch (error) {
		if(error instanceof Error) return {updateQuery:{}, updatedData: {} as LabelTag, actionLog: '', error: ResponseWrapper.badRequest(error.message)}

		return {updateQuery:{}, updatedData: {} as LabelTag, actionLog: '', error: ResponseWrapper.internalServerError('Failed to update label tag')}
	}
}

/**
 * Handles the deletion of an existing label tag.
 * @param {LabelTag} labelTagId - The ID of the label tag to delete.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelTagReturn} An object containing the update query and any validation error.
 */
export function deleteLabelTag(
	labelTagId: LabelTag & { id: string },
	tab: string,
	action: string,
): LabelTagReturn {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		const missingFieldsValidation = validateMissingFields({
			id: labelTagId.id,
		});
		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: labelTagId.id,
		});

		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$pull: {
				'label_tags.data': { _id: new ObjectId(labelTagId.id) },
			},
		};

		const actionLog = 'DELETE';

		return { updateQuery, updatedData: labelTagId, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { id: labelTagId.id },
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { id: labelTagId.id },
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to delete label tag'),
		};
	}
}

/**
 * Handles the update of label tags tab completion status.
 * @param {UpdateLabelTagsTabCompletion} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelTagReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateLabelTagsTabCompletion(
	inputData: { tab_completed: boolean },
	tab: string,
	action: string,
): Omit<LabelTagReturn, 'updatedData'> & { updatedData: { tab_completed: boolean } } {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		if (typeof inputData.tab_completed !== 'boolean') throw new Error('tab_completed must be a boolean value.');

		const updateQuery = { $set: { 'label_tags.tab_completed': inputData.tab_completed } };
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
			error: ResponseWrapper.internalServerError('Failed to update label tags tab completion'),
		};
	}
}

/**
 * @param {object} inputData
 * @param {string} tab
 * @param {string} action
 * @return {LabelTagReturn}
 */
export function updateLabelTagTaggedImage(
	inputData: { id: string; tagged_image: string; annotation_state?: object },
	tab: string,
	action: string,
): Omit<LabelTagReturn, 'updatedData'> & { updatedData: { id: string; tagged_image: string; annotation_state?: object } } {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		const missingFieldsValidation = validateMissingFields({
			id: inputData.id,
			tagged_image: inputData.tagged_image,
		});
		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateAllObjectIds({ id: inputData.id });
		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const setFields: Record<string, unknown> = {
			'label_tags.data.$[elem].tagged_image': inputData.tagged_image,
		};

		if (inputData.annotation_state !== undefined) {
			setFields['label_tags.data.$[elem].annotation_state'] = inputData.annotation_state;
		}

		const updateQuery = {
			$set: setFields,
			arrayFilters: [{ 'elem._id': new ObjectId(inputData.id) }],
		};

		const updatedData = { id: inputData.id, tagged_image: inputData.tagged_image, annotation_state: inputData.annotation_state };
		const actionLog = 'UPDATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { id: inputData.id, tagged_image: '', annotation_state: undefined },
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { id: inputData.id, tagged_image: '', annotation_state: undefined },
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update label tag tagged image'),
		};
	}
}

/**
 * @param {object} inputData
 * @param {string} tab
 * @param {string} action
 * @return {LabelTagReturn}
 */
export function updateLabelTagLegend(
	inputData: { id: string; legend_items: LegendItem[] },
	tab: string,
	action: string,
): Omit<LabelTagReturn, 'updatedData'> & { updatedData: { id: string; legend_items: LegendItem[] } } {
	try {
		const isValidatedTab = validateTab(tab, 'label-tags', action);
		if (isValidatedTab) throw new Error(isValidatedTab.body);

		const missingFieldsValidation = validateMissingFields({
			id: inputData.id,
		});
		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		if (!inputData.legend_items) {
			throw new Error('Missing required field(s): legend_items');
		}

		if (!Array.isArray(inputData.legend_items)) {
			throw new Error('legend_items must be an array');
		}

		const objectIdValidation = validateAllObjectIds({ id: inputData.id });
		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$set: {
				'label_tags.data.$[elem].legend_items': inputData.legend_items,
			},
			arrayFilters: [{ 'elem._id': new ObjectId(inputData.id) }],
		};

		const updatedData = { id: inputData.id, legend_items: inputData.legend_items };
		const actionLog = 'UPDATE';

		return { updateQuery, updatedData, actionLog, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { id: inputData.id, legend_items: [] },
				actionLog: '',
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { id: inputData.id, legend_items: [] },
			actionLog: '',
			error: ResponseWrapper.internalServerError('Failed to update label tag legend'),
		};
	}
}
