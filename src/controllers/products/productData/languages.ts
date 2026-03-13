import { APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../../utils/responseWrapper';
import { validateTab } from '../../../utils/validationUtils';
import {
	ProductLanguage,
	UpdateLanguagesInformationData,
} from '../../../types/products/languages-info';

type LanguagesInformationReturn = {
	updateQuery: Record<string, unknown>;
	updatedData: UpdateLanguagesInformationData;
	error: APIGatewayProxyResult | null;
};

const LANGUAGE_CODE_REGEX = /^[A-Z]{2}$/;

const normalizeLanguage = (language: ProductLanguage): ProductLanguage => {
	const code = typeof language.code === 'string' ? language.code.trim().toUpperCase() : '';
	const name = typeof language.name === 'string' ? language.name.trim() : '';
	const country = typeof language.country === 'string' ? language.country.trim() : undefined;

	return {
		code,
		name,
		...(country ? { country } : {}),
	};
};

const getLanguageValidationError = (languages: ProductLanguage[]): string | null => {
	const invalidLanguage = languages.find((language) => {
		return !LANGUAGE_CODE_REGEX.test(language.code) || !language.name;
	});

	if (!invalidLanguage) return null;

	return !LANGUAGE_CODE_REGEX.test(invalidLanguage.code)
		? 'Each language code must be exactly 2 letters.'
		: 'Each language must include a name.';
};

const getDuplicateLanguageCode = (languages: ProductLanguage[]): string | null => {
	const uniqueCodes = new Set<string>();

	for (const language of languages) {
		if (uniqueCodes.has(language.code)) return language.code;
		uniqueCodes.add(language.code);
	}

	return null;
};

/**
 * Updates the languages information for a product.
 * @param {UpdateLanguagesInformationData} inputData - The data containing the languages to update.
 * @param {string} tab - The tab name (should be 'languages-information').
 * @param {string} action - The action being performed.
 * @return {LanguagesInformationReturn} An object containing the update query, updated data, and any error.
 */
export function updateLanguagesInformation(
	inputData: UpdateLanguagesInformationData,
	tab: string,
	action: string,
): LanguagesInformationReturn {
	try {
		const isValidatedTabLanguagesInfo = validateTab(tab, 'languages-information', action);
		if (isValidatedTabLanguagesInfo) throw new Error(isValidatedTabLanguagesInfo.body);

		if (!inputData || !Array.isArray(inputData.languages)) {
			throw new Error('languages must be provided as an array.');
		}

		const normalizedLanguages = inputData.languages.map(normalizeLanguage);
		const validationError = getLanguageValidationError(normalizedLanguages);
		if (validationError) throw new Error(validationError);

		const duplicateCode = getDuplicateLanguageCode(normalizedLanguages);
		if (duplicateCode) throw new Error(`Duplicate language code found: ${duplicateCode}`);

		normalizedLanguages.sort((a, b) => a.name.localeCompare(b.name));

		const updatedData = { languages: normalizedLanguages };
		const updateQuery = {
			$set: {
				'languages_information.data': normalizedLanguages,
			},
		};

		return { updateQuery, updatedData, error: null };
	} catch (error) {
		if (error instanceof Error) {
			return {
				updateQuery: {},
				updatedData: { languages: [] },
				error: ResponseWrapper.badRequest(error.message),
			};
		}

		return {
			updateQuery: {},
			updatedData: { languages: [] },
			error: ResponseWrapper.internalServerError('Failed to update languages information'),
		};
	}
}
