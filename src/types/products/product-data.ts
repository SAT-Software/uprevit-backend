import { AddComplianceStandard, DeleteComplianceStandard, UpdateComplianceStandard, UpdateComplianceTabCompletion } from "./compliance-info";
import { AddLabelComponent, DeleteLabelComponent, LabelComponentTabCompletion, UpdateLabelComponent } from "./label-components";
import { AddUpdateCustomField, DeleteCustomField, UpdateProductInfo, UpdateProductInfoTabCompletion } from "./product-info";

export type UpdateProductDataRequest =
    | UpdateProductInfo
    | AddUpdateCustomField
    | DeleteCustomField
    | UpdateProductInfoTabCompletion
    | AddComplianceStandard
    | UpdateComplianceStandard
    | DeleteComplianceStandard
    | UpdateComplianceTabCompletion 
    | AddLabelComponent 
    | UpdateLabelComponent
    | DeleteLabelComponent
    | LabelComponentTabCompletion;