export interface OperationalParameters {
    id?: string;
    workbook_data?: object;
}

type BaseOperationalParametersRequest<TAction extends string, TData> = {
    id: string;
    tab: 'operational-parameters';
    action: TAction;
    data: TData;
};

export type AddOperationalParameters = BaseOperationalParametersRequest<'add_operational_parameters', OperationalParameters>;
export type UpdateOperationalParameters = BaseOperationalParametersRequest<'update_operational_parameters', Required<OperationalParameters>>;
export type DeleteOperationalParameters = BaseOperationalParametersRequest<'delete_operational_parameters', {id: string}>;
export type OperationalParametersTabCompletion = BaseOperationalParametersRequest<'update_operational_parameters_tab_completion', { tab_completed: boolean }>;