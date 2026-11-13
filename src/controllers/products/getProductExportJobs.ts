import { createListExportJobsHandler } from '../../utils/exportJobHandlers';
import { PRODUCT_EXPORT_TARGETS } from '../../utils/productExportJobs';

export const lambdaHandler = createListExportJobsHandler({ label: 'Product', target: PRODUCT_EXPORT_TARGETS });
