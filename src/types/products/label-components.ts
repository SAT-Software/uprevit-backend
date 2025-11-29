export interface labelComponent {
	id?: string;
	image?: string | null;
	dimensions?: string;
	label_type?: string[];
	component_number?: string;
	component_type?: string;
	component_description?: string;
}

type BaseLabelComponentRequest<TAction extends string, TData> = {
	id: string;
	tab: 'label-components';
	action: TAction;
	data: TData;
};

export type AddLabelComponent = BaseLabelComponentRequest<'add_label_component', labelComponent[]>;
export type UpdateLabelComponent = BaseLabelComponentRequest<'update_label_component', labelComponent & { id: string }>;
export type DeleteLabelComponent = BaseLabelComponentRequest<'delete_label_component', { id: string }>;
export type LabelComponentTabCompletion = BaseLabelComponentRequest<'update_label_component_tab_completion', { tab_completed: boolean }>;