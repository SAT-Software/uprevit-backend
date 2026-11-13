import { createListExportJobsHandler } from '../../utils/exportJobHandlers';

export const lambdaHandler = createListExportJobsHandler({ label: 'Report', target: 'report' });
