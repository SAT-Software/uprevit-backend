export interface labelComponent {
	id?: string;
	image?: string;
	name?: string;
	number?: string;
	specification_details?: string;
}

type BaseLabelComponentRequest<TAction extends string, TData> = {
	id: string;
	tab: 'label-components';
	action: TAction;
	data: TData;
};

export type AddLabelComponent = BaseLabelComponentRequest<'add_label_component', labelComponent[]>;
export type UpdateLabelComponent = BaseLabelComponentRequest<'update_label_component', Required<labelComponent>>;
export type DeleteLabelComponent = BaseLabelComponentRequest<'delete_label_component', { id: string }>;
export type LabelComponentTabCompletion = BaseLabelComponentRequest<'update_label_component_tab_completion', { tab_completed: boolean }>;