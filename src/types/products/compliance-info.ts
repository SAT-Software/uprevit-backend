export interface ComplianceInfoItem {
    _id?: string;
    standard: string;
    standard_description: string;
}

export interface UpdateComplianceInfoItem extends ComplianceInfoItem {
    id: string;
}


export type AddComplianceInfo = ComplianceInfoItem[];
export type UpdateComplianceInfo = UpdateComplianceInfoItem;

export type addComplianceStandard = {
    id: string;
    tab: 'compliance-information';
    action: 'add_compliance_standard';
    data: AddComplianceInfo;
};


export type updateComplianceStandard = {
    id: string;
    tab: 'compliance-information';
    action: 'update_compliance_standard';
    data: UpdateComplianceInfoItem;
}

export type deleteComplianceStandard = {
    id: string;
    tab: 'compliance-information';
    action: 'delete_compliance_standard';
    data: {
        id: string;
    };
}

export type updateComplianceTabCompletion = {
    id: string;
    tab: 'compliance-information';
    action: 'update_compliance_tab_completion';
    data: {
        tab_completed: boolean;
    };
}