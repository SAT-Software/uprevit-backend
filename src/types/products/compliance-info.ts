// Base data interfaces
export interface ComplianceInfoItem {
	_id?: string;
	standard: string;
	standard_description: string;
}

export interface UpdateComplianceInfoData extends ComplianceInfoItem {
	id: string;
}

export type AddComplianceInfoData = ComplianceInfoItem[];

export interface DeleteComplianceStandardData {
	id: string;
}

export interface UpdateComplianceTabCompletionData {
	tab_completed: boolean;
}

// Base request type with common properties
type BaseComplianceRequest<TAction extends string, TData> = {
	id: string;
	tab: 'compliance-information';
	action: TAction;
	data: TData;
};

// Specific request types using the base type
export type AddComplianceStandard = BaseComplianceRequest<'add_compliance_standard', AddComplianceInfoData>;

export type UpdateComplianceStandard = BaseComplianceRequest<'update_compliance_standard', UpdateComplianceInfoData>;

export type DeleteComplianceStandard = BaseComplianceRequest<'delete_compliance_standard', DeleteComplianceStandardData>;

export type UpdateComplianceTabCompletion = BaseComplianceRequest<'update_compliance_tab_completion', UpdateComplianceTabCompletionData>;
