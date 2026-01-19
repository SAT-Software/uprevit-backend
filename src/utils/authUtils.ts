import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
import { ResponseWrapper } from './responseWrapper';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/** Cognito User Pool ID from environment variables */
const userPoolId = process.env.USER_POOL_ID!;

export type TokenValidationResponse = {
	payload?: CognitoAccessTokenPayload;
	isValid: boolean;
}

export type AuthResult = {
  isValid: true;
  payload: CognitoAccessTokenPayload;
  token: string;
} | {
  isValid: false;
  error: APIGatewayProxyResult;
};

/**
 * Verifies a JWT token
 * @param {string} token - The JWT token to verify
 * @return {Promise<TokenValidationResponse>} The token validation response
 */
export async function verifyJWT(token: string): Promise<TokenValidationResponse> {
	try {
		const verifier = CognitoJwtVerifier.create({
	  userPoolId,
	  tokenUse: 'access', // or 'id' for ID tokens
	  clientId: process.env.CLIENT_ID!, // Optional, only if you need to verify the token audience
		});

		const payload = await verifier.verify(token);
		return {payload, isValid: true};
	} catch (err) {
		console.error('JWT verification failed');
		return {isValid: false};
	}
}

/**
 * Validates a role for a JWT token
 * @param {string} token - The JWT token to validate
 * @param {string} role - The role to validate
 * @return {Promise<TokenValidationResponse>} The token validation response
 */
export async function validateRole(token: string, role: string): Promise<TokenValidationResponse> {
	try {
		const verifier = CognitoJwtVerifier.create({
	  userPoolId,
	  tokenUse: 'access',
	  clientId: process.env.CLIENT_ID!,
		});

		const payload = await verifier.verify(token);
		if (payload['cognito:groups']?.includes(role)) {
	  return {payload, isValid: true};
		}

		return {isValid: false};
	} catch (err) {
		console.error('Role validation failed');
		return {isValid: false};
	}
}

/**
 * Extracts and validates JWT token from API Gateway event
 * @param {APIGatewayProxyEvent} event - API Gateway event
 * @return {Promise<AuthResult>} Authentication result with payload or error response
 */
export async function authenticateRequest(event: APIGatewayProxyEvent): Promise<AuthResult> {
	// Extract authorization header
	const authHeader = event.headers?.Authorization || event.headers?.authorization;
  
	if (!authHeader) {
		return {
	  isValid: false,
	  error: ResponseWrapper.unauthorized('Unauthorized')
		};
	}

	// Extract token
	const token = authHeader.split(' ')[1];
  
	if (!token) {
		return {
	  isValid: false,
	  error: ResponseWrapper.unauthorized('Invalid authorization header format')
		};
	}

	// Verify token
	const { isValid, payload } = await verifyJWT(token);
  
	if (!isValid || !payload) {
		return {
	  isValid: false,
	  error: ResponseWrapper.unauthorized('Unauthorized')
		};
	}

	return {
		isValid: true,
		payload,
		token
	};
}

/**
 * Authenticates request with role validation
 * @param {APIGatewayProxyEvent} event - API Gateway event
 * @param {string} requiredRole - Required role for access
 * @return {Promise<AuthResult>} Authentication result with payload or error response
 */
export async function authenticateWithRole(event: APIGatewayProxyEvent, requiredRole: string): Promise<AuthResult> {
	const authResult = await authenticateRequest(event);

	if (!authResult.isValid) {
		return authResult;
	}

	const payload = authResult.payload;
	// Assuming roles are stored in payload['cognito:groups'] as an array
	const userRoles = payload['cognito:groups'] as string[] | undefined;
	if (!userRoles || !userRoles.includes(requiredRole)) {
		return {
	  isValid: false,
	  error: ResponseWrapper.forbidden('Insufficient permissions')
		};
	}

	return authResult;
}
