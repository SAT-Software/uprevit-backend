import { AddComplianceStandard, DeleteComplianceStandard, UpdateComplianceStandard, UpdateComplianceTabCompletion } from "./compliance-info";
import { AddLabelComponent, DeleteLabelComponent, LabelComponentTabCompletion, UpdateLabelComponent } from "./label-components";
import { AddUpdateCustomField, DeleteCustomField, UpdateProductInfo, UpdateProductInfoTabCompletion } from "./product-info";
import { AddProductData, DeleteProductData, ProductDataTabCompletion, UpdateProductData } from "./product-data";
import { AddSymbolsGraphics, DeleteSymbolsGraphics, SymbolsGraphicsTabCompletion, UpdateSymbolsGraphics } from "./symbols-graphics";

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
    | LabelComponentTabCompletion
    | AddSymbolsGraphics
    | UpdateSymbolsGraphics
    | DeleteSymbolsGraphics
    | SymbolsGraphicsTabCompletion
    | AddProductData
    | UpdateProductData
    | DeleteProductData
    | ProductDataTabCompletion;