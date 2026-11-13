import { createGetExportJobHandler } from '../../utils/exportJobHandlers';

export const lambdaHandler = createGetExportJobHandler({ label: 'Report', target: 'report' });
