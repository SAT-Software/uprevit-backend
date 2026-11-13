import { createDownloadExportJobHandler } from '../../utils/exportJobHandlers';
import { PRODUCT_EXPORT_TARGETS } from '../../utils/productExportJobs';

export const lambdaHandler = createDownloadExportJobHandler({ label: 'Product', target: PRODUCT_EXPORT_TARGETS });
