export interface UpdateProductInformationData {
    market_geography: string;
    country_of_origin: string;
    oem_contract_manufacturer: string;
    commercial_clinical: string;
}

export interface AddCustomFieldData {
    label: string;
    value: string;
}

export interface UpdateCustomFieldInput {
    id: string;
    label?: string;
    value?: string;
}

export interface DeleteCustomFieldInput {
    id: string;
}

export interface UpdateProductInformationCompletionData {
    tab_completed: boolean;
}

export type UpdateProductInfo = {
    id: string;
    tab: 'product-information';
    action: 'update_product_information';
    data: UpdateProductInformationData;
};

export type AddCustomField = {
    id: string;
    tab: 'product-information';
    action: 'add_custom_field';
    data: AddCustomFieldData[];
};

export type UpdateCustomField = {
    id: string;
    tab: 'product-information';
    action: 'update_custom_field';
    data: UpdateCustomFieldInput[];
};

export type DeleteCustomField = {
    id: string;
    tab: 'product-information';
    action: 'delete_custom_field';
    data: DeleteCustomFieldInput;
};

export type UpdateProductInfoTabCompletion = {
    id: string;
    tab: 'product-information';
    action: 'update_product_information_completion';
    data: UpdateProductInformationCompletionData;
};

export type UpdateProductDataRequest =
    | UpdateProductInfo
    | AddCustomField
    | UpdateCustomField
    | DeleteCustomField
    | UpdateProductInfoTabCompletion;
