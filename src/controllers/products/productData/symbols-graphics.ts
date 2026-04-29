import { APIGatewayProxyResult } from "aws-lambda";
import { AddStandardSymbolsGraphicsData, SymbolsGraphics, SYMBOLS_GRAPHICS_ENTITIES } from "../../../types/products/symbols-graphics";
import { ResponseWrapper } from "../../../utils/responseWrapper";
import { validateAllObjectIds, validateBoolean, validateEnum, validateMissingFields, validateObjectIds, validateStringArray, validateTab } from "../../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { getDb } from "../../../utils/db";
import { StandardSymbol } from "../../../models/standardSymbols";

type SymbolsGraphicsReturn = {
    updateQuery: Record<string, unknown>;
    updatedData: any;
    error: APIGatewayProxyResult | null;
}

type PersistedSymbolsGraphics = SymbolsGraphics & {
	_id?: ObjectId;
};

const normalizeSymbolText = (value: unknown): string =>
	typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';

/**
 * @param {SymbolsGraphics[]} newSymbolsGraphics - The data for the symbols and graphics to add.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {SymbolsGraphicsReturn} An object containing the update query and updated data.
 */
export function AddSymbolsGraphics(
	newSymbolsGraphics: SymbolsGraphics[],
	tab: string,
	action: string,
): SymbolsGraphicsReturn {
	try {
		const isValidatedTabSymbolsGraphics = validateTab(tab, 'symbols-graphics', action);
		if (isValidatedTabSymbolsGraphics) throw new Error(isValidatedTabSymbolsGraphics.body);

		if(!Array.isArray(newSymbolsGraphics)) throw new Error('Data for add_symbols_graphics must be an array of symbols and graphics.');

		const componentsWithIds = newSymbolsGraphics.map(component => ({
			...component,
			_id: new ObjectId(),
		}))
        
		const updateQuery = {$push: {'symbols_graphics.data': {$each: componentsWithIds}}}
		const updatedData = componentsWithIds;

		return { updateQuery, updatedData, error: null }
	} catch (error) {
		if (error instanceof Error) return {
			updateQuery: {},
			updatedData: [],
			error: ResponseWrapper.badRequest(error.message),
		}

		return {
			updateQuery: {},
			updatedData: [],
			error: ResponseWrapper.internalServerError('Failed to add symbols and graphics'),
		}
	}
}

/**
 * @param {SymbolsGraphics} updatedSymbolsGraphics - The updated data for the symbols and graphics.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @param {PersistedSymbolsGraphics[]} existingSymbolsGraphics - Existing symbols graphics for validation and comparison.
 * @return {SymbolsGraphicsReturn} An object containing the update query and updated data.
 */
export function UpdateSymbolsGraphics(
	updatedSymbolsGraphics: Required<SymbolsGraphics>,
	tab: string,
	action: string,
	existingSymbolsGraphics: PersistedSymbolsGraphics[] = [],
): SymbolsGraphicsReturn {
	try {
		const isValidatedTabSymbolsGraphics = validateTab(tab, 'symbols-graphics', action);
		if (isValidatedTabSymbolsGraphics) throw new Error(isValidatedTabSymbolsGraphics.body);
        
		const missingFieldsValidation = validateMissingFields({
			id: updatedSymbolsGraphics.id,
			text: updatedSymbolsGraphics.text,
		})
		if(missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const stringArrayValidation = validateStringArray(updatedSymbolsGraphics.label_presence, 'label_presence');
		if(stringArrayValidation) throw new Error(stringArrayValidation.body);

		const enumValidation = validateEnum(SYMBOLS_GRAPHICS_ENTITIES, updatedSymbolsGraphics.entity);
		if(enumValidation) throw new Error(enumValidation.body);

		// Only validate text_present when entity is "Symbols"
		if (updatedSymbolsGraphics.entity === 'Symbols') {
			const booleanValidation = validateBoolean(updatedSymbolsGraphics.text_present, 'text_present');
			if(booleanValidation) throw new Error(booleanValidation.body);
		}

		const objectIdValidation =validateAllObjectIds({id: updatedSymbolsGraphics.id})
		if(objectIdValidation) throw new Error(objectIdValidation.body);

		const updateSet: Record<string, unknown> = {
			'symbols_graphics.data.$[elem].image': updatedSymbolsGraphics.image,
			'symbols_graphics.data.$[elem].text': updatedSymbolsGraphics.text,
			'symbols_graphics.data.$[elem].description': updatedSymbolsGraphics.description,
			'symbols_graphics.data.$[elem].text_present': updatedSymbolsGraphics.text_present,
			'symbols_graphics.data.$[elem].label_presence': updatedSymbolsGraphics.label_presence,
			'symbols_graphics.data.$[elem].entity': updatedSymbolsGraphics.entity,
		};

		if (updatedSymbolsGraphics.key !== undefined) {
			updateSet['symbols_graphics.data.$[elem].key'] = updatedSymbolsGraphics.key;
		}

		if (typeof updatedSymbolsGraphics.count === 'number') {
			updateSet['symbols_graphics.data.$[elem].count'] = updatedSymbolsGraphics.count;
		}

		const updateUnset: Record<string, ""> = {};
		const existingSymbolsGraphic = existingSymbolsGraphics.find((item) => item._id?.toString() === updatedSymbolsGraphics.id);
		const isStandardSymbol = Boolean(existingSymbolsGraphic?.standard_symbol_id || existingSymbolsGraphic?.standard_ref_number);
		const coreFieldsChanged = isStandardSymbol
			&& existingSymbolsGraphic?.key !== updatedSymbolsGraphics.key;

		if (coreFieldsChanged) {
			updateUnset['symbols_graphics.data.$[elem].standard_symbol_id'] = "";
			updateUnset['symbols_graphics.data.$[elem].standard_ref_number'] = "";
		}

		const updateQuery: Record<string, unknown> = {
			$set: updateSet,
			arrayFilters: [{'elem._id': new ObjectId(updatedSymbolsGraphics.id!)}],
		};

		if (Object.keys(updateUnset).length) {
			updateQuery.$unset = updateUnset;
		}

		const updatedData = updatedSymbolsGraphics;

		return {updateQuery, updatedData, error: null}
	} catch (error) {
		if(error instanceof Error) return {updateQuery:{}, updatedData: {} as SymbolsGraphics, error: ResponseWrapper.badRequest(error.message)}

		return {updateQuery:{}, updatedData: {} as SymbolsGraphics, error: ResponseWrapper.internalServerError('Failed to update symbols and graphics')}
	}
}

/**
 * Handles the deletion of an existing symbols graphics.
 * @param {SymbolsGraphics} SymbolsGraphicsId - The ID of the symbols graphics to delete.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {SymbolsGraphicsReturn} An object containing the update query and any validation error.
 */
export function deleteSymbolsGraphics(
	SymbolsGraphicsId: SymbolsGraphics & { id: string },
	tab: string,
	action: string,
): SymbolsGraphicsReturn {
	try {
		const isValidatedTabSymbolsGraphics = validateTab(tab, 'symbols-graphics', action);
		if (isValidatedTabSymbolsGraphics) throw new Error(isValidatedTabSymbolsGraphics.body);

		const missingFieldsValidation = validateMissingFields({
			id: SymbolsGraphicsId.id,
		});
		if (missingFieldsValidation) throw new Error(missingFieldsValidation.body);

		const objectIdValidation = validateObjectIds({
			id: SymbolsGraphicsId.id,
		});

		if (objectIdValidation) throw new Error(objectIdValidation.body);

		const updateQuery = {
			$pull: {
				'symbols_graphics.data': { _id: new ObjectId(SymbolsGraphicsId.id) },
			},
		};

		return { updateQuery, updatedData: SymbolsGraphicsId, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { id: '' },
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { id: '' },
			error: ResponseWrapper.internalServerError('Failed to delete symbols graphics'),
		};
	}
}

/**
 * Handles the update of compliance information tab completion status.
 * @param {UpdateSymbolsGraphicsTabCompletion} inputData - The data object containing the tab completion status.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @return {SymbolsGraphicsReturn} An object containing the update query, updated data, and any validation error.
 */
export function updateSymbolsGraphicsTabCompletion(
	inputData: { tab_completed: boolean },
	tab: string,
	action: string,
): Omit<SymbolsGraphicsReturn, 'updatedData'> & { updatedData: { tab_completed: boolean } } {
	try {
		const isValidatedTabSymbolsGraphics = validateTab(tab, 'symbols-graphics', action);
		if (isValidatedTabSymbolsGraphics) throw new Error(isValidatedTabSymbolsGraphics.body);

		if (typeof inputData.tab_completed !== 'boolean') throw new Error('tab_completed must be a boolean value.');

		const updateQuery = { $set: { 'symbols_graphics.tab_completed': inputData.tab_completed } };
		const updatedData = { tab_completed: inputData.tab_completed };

		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error)
			return {
				updateQuery: {},
				updatedData: { tab_completed: false },
				error: ResponseWrapper.badRequest(error.message),
			};
		return {
			updateQuery: {},
			updatedData: { tab_completed: false },
			error: ResponseWrapper.internalServerError('Failed to update symbols graphics tab completion'),
		};
	}
}


/**
 * @param {AddStandardSymbolsGraphicsData} data - The standard symbols selected for the product.
 * @param {string} tab - The current tab being updated.
 * @param {string} action - The action being performed.
 * @param {PersistedSymbolsGraphics[]} existingSymbolsGraphics - Existing product symbols for duplicate checks.
 * @return {SymbolsGraphicsReturn} An object containing the update query and updated data.
 */
export async function AddStandardSymbolsGraphics(
	data: AddStandardSymbolsGraphicsData,
	tab: string,
	action: string,
	existingSymbolsGraphics: PersistedSymbolsGraphics[],
): Promise<SymbolsGraphicsReturn>{
	try {
		const isValidatedTabSymbolsGraphics = validateTab(tab, 'symbols-graphics', action);
		if (isValidatedTabSymbolsGraphics) throw new Error(isValidatedTabSymbolsGraphics.body);

		if (!data || !Array.isArray(data.symbols) || data.symbols.length === 0) {
			throw new Error('At least one standard symbol selection is required.');
		}

		const selectionsById = new Map<string, AddStandardSymbolsGraphicsData['symbols'][number]>();
		for (const selection of data.symbols) {
			if (!selection.id || !ObjectId.isValid(selection.id)) {
				throw new Error('Each standard symbol selection must include a valid id.');
			}

			const stringArrayValidation = validateStringArray(selection.label_presence || [], 'label_presence');
			if (stringArrayValidation) throw new Error(stringArrayValidation.body);

			
			const booleanValidation = validateBoolean(selection.text_present, 'text_present');
			if (booleanValidation) throw new Error(booleanValidation.body);
			

			selectionsById.set(selection.id, selection);
		}

		const db = await getDb();
		const objectIds = [...selectionsById.keys()].map((id) => new ObjectId(id));
		const standardSymbols = await db.collection<StandardSymbol>('standard_symbols')
			.find({ _id: { $in: objectIds }, active: true })
			.toArray();

		const foundIds = new Set(standardSymbols.map((symbol) => symbol._id?.toString()).filter(Boolean));
		const missingIds = [...selectionsById.keys()].filter((id) => !foundIds.has(id));
		if (missingIds.length) {
			throw new Error(`Standard symbols not found or inactive: ${missingIds.join(', ')}`);
		}

		const existingStandardIds = new Set(
			existingSymbolsGraphics
				.map((item) => item.standard_symbol_id)
				.filter((id): id is string => Boolean(id)),
		);
		const existingSymbolTexts = new Set(existingSymbolsGraphics.map((item) => normalizeSymbolText(item.text)));
		const added: PersistedSymbolsGraphics[] = [];
		const skipped: Array<{ id: string; reason: string }> = [];

		for (const symbol of standardSymbols) {
			const symbolId = symbol._id?.toString();
			if (!symbolId) continue;

			if (existingStandardIds.has(symbolId)) {
				skipped.push({ id: symbolId, reason: 'standard_symbol_id already exists in product' });
				continue;
			}

			if (existingSymbolTexts.has(normalizeSymbolText(symbol.title))) {
				skipped.push({ id: symbolId, reason: 'symbol already exists in product' });
				continue;
			}

			const selection = selectionsById.get(symbolId)!;
			added.push({
				_id: new ObjectId(),
				image: '',
				key: symbol.image_key,
				text: symbol.title,
				text_present: selection.text_present,
				label_presence: selection.label_presence || [],
				entity: 'Symbols',
				standard_symbol_id: symbolId,
				standard_ref_number: symbol.ref_number,
			});
		}

		const updateQuery = added.length
			? {$push: {'symbols_graphics.data': {$each: added}}}
			: {};
		const updatedData = { added, skipped };

		return { updateQuery, updatedData, error: null }
	} catch (error) {
		if (error instanceof Error) return {
			updateQuery: {},
			updatedData: [],
			error: ResponseWrapper.badRequest(error.message),
		}

		return {
			updateQuery: {},
			updatedData: [],
			error: ResponseWrapper.internalServerError('Failed to add standard symbols in this product'),
		}
	}
}
