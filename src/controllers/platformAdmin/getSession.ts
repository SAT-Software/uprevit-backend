import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requirePlatformOperator } from '../../utils/platformAdminContext';
import { serializePlatformOperator } from '../../utils/platformAdminSerializers';

/**
 * Returns the authenticated platform operator profile.
 * @param {APIGatewayProxyEvent} event API Gateway request event
 * @return {Promise<APIGatewayProxyResult>} Platform operator session payload
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const operatorResult = await requirePlatformOperator(event);
		if (!operatorResult.ok) return operatorResult.response;

		const { operator } = operatorResult.context;

		return ResponseWrapper.success({
			message: 'Platform operator session retrieved',
			data: serializePlatformOperator(operator),
		});
	} catch (error) {
		logError('Platform admin get session failed', error);
		return ResponseWrapper.internalServerError('Failed to load platform operator session');
	}
};
