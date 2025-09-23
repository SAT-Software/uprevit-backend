import { ObjectId } from 'mongodb';

export type Product = {
  _id?: ObjectId;
  project_id: ObjectId;
  department_id?: ObjectId;
  product_plan_number: string;
  product_name: string;
  product_description: string;
  master_version: string;
  isActive: boolean;
  target_date?: Date | null;
  actual_completion_date?: Date | null;
  status: 'draft' | 'submitted' | 'archive';
  complete_count: number;
  product_information: {
    market_geography: string;
    country_of_origin: string;
    oem_contract_manufacturer: string;
    commercial_clinical: string;
    custom_fields?: Array<{
      _id: ObjectId;
      label: string;
      value: string;
    }>;
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
  symbols_graphics: Array<{
    _id: ObjectId;
    image: string;
    text: string;
    description?: string;
    text_present?: boolean;
    label_presence: string[];
    entity: 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components';
  }>;
};
