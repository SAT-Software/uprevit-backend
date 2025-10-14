import { APIGatewayProxyResult } from 'aws-lambda';
import { validateTab } from '../../../utils/validationUtils';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { labelComponent } from '../../../types/products/label-components';
import { ObjectId } from 'mongodb';

type LabelComponentReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: labelComponent;
	actionLog: string;
	error: APIGatewayProxyResult | null;
};

/**
 * Handles the addition of a new label component.
 * @param {labelComponent} newLabelComponentData - The new label component to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {LabelComponentReturn} An object containing the update query, updated data, and any validation error.
 */
export function addLabelComponent(
	newLabelComponentData: labelComponent,
	tab: string,
	action: string,
): LabelComponentReturn {
	try {
		const isValidatedTabLabelComponents = validateTab(tab, 'label-components', action);
		if (isValidatedTabLabelComponents) throw new Error(isValidatedTabLabelComponents.body);

		const componentWithId = {
			...newLabelComponentData,
			_id: new ObjectId(),
		};

		const updateQuery = { $push: { 'label_components.data': componentWithId } };
		const updatedData = componentWithId;
		const actionLog = 'CREATE';

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
			error: ResponseWrapper.internalServerError('Failed to add label component'),
		};
	}
}