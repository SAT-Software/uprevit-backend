import { AddComplianceStandard, DeleteComplianceStandard, UpdateComplianceStandard, UpdateComplianceTabCompletion } from "./compliance-info";
import { AddUpdateCustomField, DeleteCustomField, UpdateProductInfo, UpdateProductInfoTabCompletion } from "./product-info";

export type UpdateProductDataRequest =
    | UpdateProductInfo
    | AddUpdateCustomField
    | DeleteCustomField
    | UpdateProductInfoTabCompletion
    | AddComplianceStandard
    | UpdateComplianceStandard
    | DeleteComplianceStandard
    | UpdateComplianceTabCompletion;