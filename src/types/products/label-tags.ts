export interface LabelTag {
    id?: string,
    name?: string,
    description?: string,
    type?: string,
    image?: string,
    key?: string,
    tagged_image?: string,
    tagged_image_key?: string,
    annotation_state?: object,
    legend_items?: LegendItem[],
}

export type LegendItem = {
    id: string;
    shape: string;
    strokeStyle?: string;
    strokeColor?: string;
    strokeWidth?: number;
    fillColor?: string;
    fillOpacity?: number;
    text: string;
};

export type BaseLabelTag<Action extends string, TData> = {
    id: string;
    action: Action;
    tab: 'label-tags';
    data: TData;
}

export type AddLabelTag = BaseLabelTag<'add_label_tags', LabelTag[]>;
export type UpdateLabelTag = BaseLabelTag<'update_label_tags', Required<LabelTag>>;
export type UpdateLabelTagTaggedImage = BaseLabelTag<'update_label_tag_tagged_image', { id: string; tagged_image?: string; tagged_image_key?: string; annotation_state?: object }>;
export type UpdateLabelTagLegend = BaseLabelTag<'update_label_tag_legend', { id: string; legend_items: LegendItem[] }>;
export type DeleteLabelTag = BaseLabelTag<'delete_label_tags', { id: string }>;
export type LabelTagsTabCompletion = BaseLabelTag<'update_label_tags_tab_completion', { tab_completed: boolean }>;
