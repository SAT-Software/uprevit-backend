import { ObjectId } from 'mongodb';
import { AuditLog } from './auditLog';

export type ProductData ={
	data: {
			_id?: ObjectId;
			workspace_id: ObjectId;
			project_id: ObjectId;
			department_id?: ObjectId;
			product_plan_number: string;
			product_name: string;
			product_description: string;
			version: number;
			is_latest: boolean;
			parent_id?: ObjectId | null;
			target_date?: Date | null;
			actual_completion_date?: Date | null;
			status: 'draft' | 'submitted' | 'archived';
			complete_count?: number;
		}
}

export type ProductInformation = {
	product_data: ProductData,
	data: {
			market_geography: string;
			country_of_origin: string;
			oem_contract_manufacturer: string;
			commercial_clinical: string;
			manufacturing_location: string;
			custom_fields?: Array<{
				_id: ObjectId;
				label: string;
				value: string;
			}>;
		};
	custom_fields?: Array<{
		_id: ObjectId;
		label: string;
		value: string;
	}>;
	tab_completed: boolean;
};

export type ComplianceInformation = {
	product_data: ProductData,
	data: Array<{
			_id: ObjectId;
			standard: string;
			standard_description: string;
	}>;
	tab_completed: boolean;
};

export type LabelComponents = {
	product_data: ProductData,
	data: Array<{
			_id: ObjectId;
			image?: string | null;
			dimensions?: string;
			label_type?: string[];
			component_number: string;
			component_type: string;
			component_description: string;
	}>;
	tab_completed: boolean;
};

export type SymbolsGraphics = {
	product_data: ProductData,
	data: Array<{
			_id: ObjectId;
			image: string;
			text: string;
			description?: string;
			text_present?: boolean;
			label_presence: string[];
			entity: 'Symbols' | 'Schematics' | 'Barcodes' | 'Other Components';
			count?: number;
	}>;
	tab_completed: boolean;
};

export type ExcelData = {
	product_data: ProductData,
	data: {
			_id: ObjectId;
			workbook_data: {};
	};
	tab_completed: boolean;
};

export type LabelTags = {
	product_data: ProductData,
	data: Array<{
			_id: ObjectId;
			name?: string;
			description?: string;
			type?: string;
			image?: string;
			tagged_image?: string;
			annotation_state?: object;
	}>;
	tab_completed: boolean;
};

export type Product = {
	_id?: ObjectId;
	workspace_id: ObjectId;
	project_id: ObjectId;
	department_id?: ObjectId;
	product_plan_number: string;
	product_name: string;
	product_description: string;
	version: number;
	is_latest: boolean;
	parent_id?: ObjectId | null;
	target_date?: Date | null;
	actual_completion_date?: Date | null;
	status: 'draft' | 'submitted' | 'archived';
	complete_count?: number;
	product_information: ProductInformation;
	compliance_information: ComplianceInformation;
	label_components: LabelComponents;
	symbols_graphics: SymbolsGraphics;
	product_data: ExcelData;
	operational_parameters: ExcelData;
	label_tags: LabelTags;
	auditLogs?: AuditLog[];
};
