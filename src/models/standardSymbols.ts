import { ObjectId } from "mongodb";

export interface StandardSymbol{
    _id?: ObjectId;
    title: string;
    standard: string;
    standard_description?: string;
    ref_number: string;
    image_key: string;
    active: boolean;
    sort_order?: number;
    created_at?: Date;
    updated_at?: Date;
}
