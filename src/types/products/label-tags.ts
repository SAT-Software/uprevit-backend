export interface LabelTag {
    id?: string,
    name?: string,
    description?: string,
    type?: string,
    image?: string,
    tagged_image?: string,
}

export type BaseLabelTag<Action extends string, TData> = {
    id: string;
    action: Action;
    tab: 'label-tags';
    data: TData;
}

export type AddLabelTag = BaseLabelTag<'add_label_tags', LabelTag[]>;
export type UpdateLabelTag = BaseLabelTag<'update_label_tags', Required<LabelTag>>;
export type UpdateLabelTagTaggedImage = BaseLabelTag<'update_label_tag_tagged_image', { id: string; tagged_image: string }>;
export type DeleteLabelTag = BaseLabelTag<'delete_label_tags', { id: string }>;
export type LabelTagsTabCompletion = BaseLabelTag<'update_label_tags_tab_completion', { tab_completed: boolean }>;