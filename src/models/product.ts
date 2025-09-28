import { ObjectId } from 'mongodb';

export type Product = {
    _id?: ObjectId;
    project_id: ObjectId;
    department_id?: ObjectId;
    product_plan_number: string;
    product_name: string;
    product_description: string;
    master_version: string;
    target_date?: Date | null;
    actual_completion_date?: Date | null;
    status: 'draft' | 'submitted' | 'archived';
    complete_count?: number;
    product_information: {
        data: {
            _id: ObjectId;
            market_geography: string;
            country_of_origin: string;
            oem_contract_manufacturer: string;
            commercial_clinical: string;
            custom_fields?: Array<{
                _id: ObjectId;
                label: string;
                value: string;
            }>;
        };
        tab_completed: boolean;
    };
    compliance_information: {
        data: Array<{
            _id: ObjectId;
            standard: string;
            standard_description: string;
        }>;
        tab_completed: boolean;
    };
    label_components: {
        data: Array<{
            _id: ObjectId;
            component_image: string;
            component_name: string;
            component_number: string;
            specification_details: string;
        }>;
        tab_completed: boolean;
    };
    symbols_graphics: {
        data: Array<{
            _id: ObjectId;
            image: string;
            text: string;
            description?: string;
            text_present?: boolean;
            label_presence: string[];
            entity: 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components';
        }>;
        tab_completed: boolean;
    };
    product_data: {
        data: {
            _id: ObjectId;
            workbook_data: {};
        };
        tab_completed: boolean;
    };
    operational_parameters: {
        data: {
            _id: ObjectId;
            workbook_data: {};
        };
        tab_completed: boolean;
    };
    label_tags: {
        data: Array<{
            _id: ObjectId;
            label_name: string;
            label_description: string;
            label_type: string;
            label_image: boolean;
        }>;
        tab_completed: boolean;
    };
};
