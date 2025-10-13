// Base data interfaces
export interface UpdateProductInformationData {
    market_geography: string;
    country_of_origin: string;
    oem_contract_manufacturer: string;
    commercial_clinical: string;
}

export interface CustomFieldInput {
    id?: string;
    label?: string;
    value?: string;
}

export interface DeleteCustomFieldInput {
    id: string;
}

export interface UpdateProductInformationCompletionData {
    tab_completed: boolean;
}

// Base request type with common properties
type BaseProductRequest<TAction extends string, TData> = {
    id: string;
    tab: 'product-information';
    action: TAction;
    data: TData;
};

// Specific request types using the base type
export type UpdateProductInfo = BaseProductRequest<'update_product_information', UpdateProductInformationData>;

export type AddUpdateCustomField = BaseProductRequest<'add_custom_field' | 'update_custom_field', CustomFieldInput[]>;

export type DeleteCustomField = BaseProductRequest<'delete_custom_field', DeleteCustomFieldInput>;

export type UpdateProductInfoTabCompletion = BaseProductRequest<'update_product_information_completion', UpdateProductInformationCompletionData>;

// Union type for all product information requests
export type UpdateProductDataRequest =
    | UpdateProductInfo
    | AddUpdateCustomField
    | DeleteCustomField
    | UpdateProductInfoTabCompletion
    | addComplianceStandard
    | updateComplianceStandard
    | deleteComplianceStandard
    | updateComplianceTabCompletion;
