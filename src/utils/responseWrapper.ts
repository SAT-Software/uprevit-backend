import { APIGatewayProxyResult } from 'aws-lambda';
import { StatusCodes } from './statusCodes';

export interface ResponseData {
	message?: string;
	error?: string;
	timestamp?: string;
	[key: string]: any;
}

export class ResponseWrapper {
	static success(data: ResponseData = {}, statusCode: number = StatusCodes.SUCCESS): APIGatewayProxyResult {
		return {
			statusCode,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		};
	}

	static created(data: ResponseData = {}): APIGatewayProxyResult {
		return this.success(data, StatusCodes.CREATED);
	}

	static badRequest(message: string, additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.BAD_REQUEST);
	}

	static unauthorized(message: string = 'Unauthorized', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.UNAUTHORIZED);
	}

	static forbidden(message: string = 'Forbidden', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.FORBIDDEN);
	}

	static notFound(message: string = 'Resource not found', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.NOT_FOUND);
	}

	static conflict(message: string = 'Resource already exists', additionalData: ResponseData = {}): APIGatewayProxyResult {
		return this.success({
			message,
			...additionalData,
		}, StatusCodes.CONFLICT);
	}

	static internalServerError(error: Error | string, additionalData: ResponseData = {}): APIGatewayProxyResult {
		const errorMessage = error instanceof Error ? error.message : error;
		return this.success({
			message: 'Internal server error',
			error: errorMessage,
			timestamp: new Date().toISOString(),
			...additionalData,
		}, StatusCodes.INTERNAL_SERVER_ERROR);
	}

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
