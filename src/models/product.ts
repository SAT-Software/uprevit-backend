import { ObjectId } from 'mongodb';

export type Product = {
	_id?: ObjectId;
	project_id: ObjectId;
	department_id: ObjectId;
	product_plan_number: string;
	product_name: string;
	product_description: string;
	master_version: string; 
	isActive: boolean; 
	target_date?: Date;
	actual_completion_date?: Date;
	status: string; 
	complete_count: number; 
	product_information: {
		market_geography: string;
		country_of_origin: string;
		oem_contract_manufacturer: string;
		commercial_clinical: string;
		custom_fields?: Array<{
			_id: ObjectId;
			field_name: string;
			field_value: string;
		}>;
		tab_completed: boolean; 
	};
	compliance_information: {
		data: Array<{
			_id: ObjectId;
			compliance_type: string;
			status: string;
			reference_number?: string;
			notes?: string;
		}>;
		tab_completed: boolean; 
	};
	label_components: {
		data: Array<{
			_id: ObjectId;
			component_name: string;
			component_type?: string;
			dimensions?: string;
			material?: string;
			color?: string;
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