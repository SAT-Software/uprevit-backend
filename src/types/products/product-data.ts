export interface ProductData {
    id?: string;
    workbook_data?: object;
}

type BaseProductDataRequest<TAction extends string, TData> = {
    id: string;
    tab: 'product-specifications';
    action: TAction;
    data: TData;
};

export type AddProductData = BaseProductDataRequest<'add_product_data', ProductData>;
export type UpdateProductData = BaseProductDataRequest<'update_product_data', Required<ProductData>>;
export type DeleteProductData = BaseProductDataRequest<'delete_product_data', {id: string}>;
export type ProductDataTabCompletion = BaseProductDataRequest<'update_product_data_tab_completion', { tab_completed: boolean }>;