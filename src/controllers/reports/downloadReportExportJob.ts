import { createDownloadExportJobHandler } from '../../utils/exportJobHandlers';

export const lambdaHandler = createDownloadExportJobHandler({ label: 'Report', target: 'report' });
