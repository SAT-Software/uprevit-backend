import { APIGatewayProxyResult } from 'aws-lambda';
import { StatusCodes } from './statusCodes';

export interface ResponseData {
	message?: string;
	error?: string;
	timestamp?: string;
	[key: string]: any;
}

/**
 * Utility class for creating standardized API Gateway proxy responses
 */
export class ResponseWrapper {
	/**
	 * Creates a successful response with the given data and status code
	 * @param {ResponseData} data - The response data to include in the body
	 * @param {number} statusCode - HTTP status code (defaults to 200)
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with the specified data and status code
	 */
	static success(data: ResponseData = {}, statusCode: number = StatusCodes.SUCCESS): APIGatewayProxyResult {
		return {
			statusCode,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		};
	}

	/**
	 * Creates a 201 Created response
	 * @param {ResponseData} data - The response data to include in the body
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 201 status code
	 */
	static created(data: ResponseData = {}): APIGatewayProxyResult {
		return this.success(data, StatusCodes.CREATED);
	}

	/**
	 * Creates a 202 Accepted response
	 * @param {ResponseData} data - The response data to include in the body
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 202 status code
	 */
	static accepted(data: ResponseData = {}): APIGatewayProxyResult {
		return this.success(data, StatusCodes.ACCEPTED);
	}

	/**
	 * Creates a 400 Bad Request response
	 * @param {string} message - Error message describing the bad request
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 400 status code
	 */
	static badRequest(message: string, additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.BAD_REQUEST);
	}

	/**
	 * Creates a 401 Unauthorized response
	 * @param {string} message - Error message (defaults to 'Unauthorized')
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 401 status code
	 */
	static unauthorized(message: string = 'Unauthorized', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.UNAUTHORIZED);
	}

	/**
	 * Creates a 403 Forbidden response
	 * @param {string} message - Error message (defaults to 'Forbidden')
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 403 status code
	 */
	static forbidden(message: string = 'Forbidden', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.FORBIDDEN);
	}

	/**
	 * Creates a 404 Not Found response
	 * @param {string} message - Error message (defaults to 'Resource not found')
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 404 status code
	 */
	static notFound(message: string = 'Resource not found', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.NOT_FOUND);
	}

	/**
	 * Creates a 409 Conflict response
	 * @param {string} message - Error message (defaults to 'Resource already exists')
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 409 status code
	 */
	static conflict(message: string = 'Resource already exists', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.CONFLICT);
	}

	/**
	 * Creates a 500 Internal Server Error response
	 * @param {Error | string} error - Error object or error message
	 * @param {ResponseData} additionalData - Additional data to include in the response
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with 500 status code
	 */
	static internalServerError(error: Error | string, additionalData: ResponseData = {}): APIGatewayProxyResult {
		const errorMessage = error instanceof Error ? error.message : error;
		return this.success({
			message: 'Internal server error',
			error: errorMessage,
			timestamp: new Date().toISOString(),
			...additionalData,
		}, StatusCodes.INTERNAL_SERVER_ERROR);
	}

	/**
	 * Creates a custom response with the specified status code and data
	 * @param {number} statusCode - HTTP status code
	 * @param {ResponseData} data - The response data to include in the body
	 * @return {APIGatewayProxyResult} APIGatewayProxyResult with the specified status code and data
	 */
	static custom(statusCode: number, data: ResponseData = {}): APIGatewayProxyResult {
		return {
			statusCode,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		};
	}
}
