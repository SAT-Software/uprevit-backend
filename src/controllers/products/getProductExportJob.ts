import { createGetExportJobHandler } from '../../utils/exportJobHandlers';
import { PRODUCT_EXPORT_TARGETS } from '../../utils/productExportJobs';

export const lambdaHandler = createGetExportJobHandler({ label: 'Product', target: PRODUCT_EXPORT_TARGETS });
