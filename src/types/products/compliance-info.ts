// Base data interfaces
export interface ComplianceStandard {
	_id?: string;
	standard: string;
	standard_description: string;
}

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
export type AddComplianceStandard = BaseComplianceRequest<'add_compliance_standard', ComplianceStandard[]>;

export type UpdateComplianceStandard = BaseComplianceRequest<
	'update_compliance_standard',
	ComplianceStandard & { id: string }
>;

export type DeleteComplianceStandard = BaseComplianceRequest<'delete_compliance_standard', DeleteComplianceStandardData>;

export type UpdateComplianceTabCompletion = BaseComplianceRequest<
	'update_compliance_tab_completion',
	UpdateComplianceTabCompletionData
>;
