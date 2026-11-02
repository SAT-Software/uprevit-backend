import { APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { logError } from '../../utils/logger';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { withTelemetry } from '../../utils/telemetry';

const NO_STORE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const HEALTH_TIMEOUT_MS = 5000;

/**
 * Public health check for uptime monitoring; verifies the database answers a ping.
 * @return {Promise<APIGatewayProxyResult>} 200 when healthy, 503 otherwise
 */
export const lambdaHandler = withTelemetry(async (): Promise<APIGatewayProxyResult> => {
	try {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Health check timed out')), HEALTH_TIMEOUT_MS);
		});
		try {
			await Promise.race([getDb().then((db) => db.command({ ping: 1 })), timeout]);
		} finally {
			clearTimeout(timer);
		}
		return { ...ResponseWrapper.success({ status: 'ok' }), headers: NO_STORE_HEADERS };
	} catch (error) {
		logError('Health check failed', error);
		return { ...ResponseWrapper.custom(503, { status: 'error' }), headers: NO_STORE_HEADERS };
	}
});
