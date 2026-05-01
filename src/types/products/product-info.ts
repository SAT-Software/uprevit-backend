
// Base data interfaces
export interface UpdateProductInformationData {
    product_name: string;
    product_plan_number: string;
    product_description: string;
    target_date: Date | null;
    actual_completion_date: Date | null;
    market_geography: string;
    country_of_origin: string;
    oem_contract_manufacturer: string;
    commercial_clinical: string;
    manufacturing_location: string;
    class_of_device?: string;
    basic_udi_di?: string;
}

export interface CustomFieldInput {
    id?: string;
    field_id?: string;
    parent_id?: string | null;
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
