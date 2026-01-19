import {APIGatewayProxyEvent, APIGatewayProxyResult} from 'aws-lambda';
import {authenticateRequest} from './utils/authUtils';
import {ResponseWrapper} from './utils/responseWrapper';

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent):
	Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);

		if (!auth.isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		return ResponseWrapper.success(
			{
				message: 'Hello from Lambda!',
				database: 'Connected successfully',
				timestamp: new Date().toISOString(),
			}
		);
	} catch (err) {
		console.error('Hello world handler failed');
		return ResponseWrapper.internalServerError('An error occurred');
	}
};
