export interface ProductLanguage {
	code: string;
	name: string;
	country?: string;
}

export interface UpdateLanguagesInformationData {
	languages: ProductLanguage[];
}

type BaseLanguagesRequest<TAction extends string, TData> = {
	id: string;
	tab: 'languages-information';
	action: TAction;
	data: TData;
};

export type UpdateLanguagesInformation = BaseLanguagesRequest<
	'update_languages_information',
	UpdateLanguagesInformationData
>;
