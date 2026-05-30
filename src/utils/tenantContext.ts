import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { authenticateRequest, type AuthResult } from './authUtils';
import { getAuthenticatedUserContext } from './authenticatedUser';
import { ResponseWrapper } from './responseWrapper';

export type TenantContext = {
	workspaceId: ObjectId;
	userId: ObjectId;
	cognitoSub: string;
	cognitoGroups: string[];
};

export type TenantContextResult =
	| { ok: true; context: TenantContext; auth: Extract<AuthResult, { isValid: true }> }
	| { ok: false; response: APIGatewayProxyResult };

const parseCognitoGroups = (groups: unknown): string[] => {
	if (Array.isArray(groups)) {
		return groups.filter((group): group is string => typeof group === 'string');
	}

	if (typeof groups === 'string') {
		return groups.split(',').map((group) => group.trim()).filter(Boolean);
	}

	return [];
};

/**
 * Authenticates the request and resolves the caller's workspace from MongoDB.
 * @param {APIGatewayProxyEvent} event - API Gateway event
 * @return {Promise<TenantContextResult>} Tenant context result
*/
export const requireTenantContext = async (
	event: APIGatewayProxyEvent,
): Promise<TenantContextResult> => {
	const auth = await authenticateRequest(event);
	if (!auth.isValid) {
		return { ok: false, response: auth.error };
	}

	const cognitoSub = auth.payload.sub;
	if (!cognitoSub) {
		return { ok: false, response: ResponseWrapper.unauthorized('Unauthorized') };
	}

	const userContext = await getAuthenticatedUserContext(cognitoSub);
	if (!userContext) {
		return {
			ok: false,
			response: ResponseWrapper.unauthorized('Unable to resolve authenticated user context'),
		};
	}

	return {
		ok: true,
		context: {
			workspaceId: userContext.workspaceId,
			userId: userContext.userId,
			cognitoSub,
			cognitoGroups: parseCognitoGroups(auth.payload['cognito:groups']),
		},
		auth,
	};
};

/**
 * Returns a 403 response when the requested workspace does not match the caller's workspace.
 * @param {string | ObjectId} requestedWorkspaceId - The requested workspace id
 * @param {ObjectId} contextWorkspaceId - The context workspace id
 * @param {string} message - The message to return in the response
 * @return {APIGatewayProxyResult | null} The response or null if the workspaces match
*/
export const assertWorkspaceMatch = (
	requestedWorkspaceId: string | ObjectId,
	contextWorkspaceId: ObjectId,
	message = 'You are not authorized to access resources for this workspace',
): APIGatewayProxyResult | null => {
	const requestedId = requestedWorkspaceId instanceof ObjectId
		? requestedWorkspaceId
		: ObjectId.createFromHexString(requestedWorkspaceId.toString());

	if (requestedId.toString() !== contextWorkspaceId.toString()) {
		return ResponseWrapper.forbidden(message);
	}

	return null;
};

/**
 * Standard Mongo filter for tenant-scoped resource lookups by id.
 * @param {string | ObjectId} resourceId - The resource id
 * @param {ObjectId} workspaceId - The workspace id
 * @return {Object} The filter object
*/
export const tenantObjectIdFilter = (
	resourceId: string | ObjectId,
	workspaceId: ObjectId,
): { _id: ObjectId; workspace_id: ObjectId } => {
	const id = resourceId instanceof ObjectId ? resourceId : new ObjectId(resourceId.toString());

	return {
		_id: id,
		workspace_id: workspaceId,
	};
};

/**
 * Standard Mongo filter for tenant-scoped user lookups by id.
 * @param {string | ObjectId} userId - The user id
 * @param {ObjectId} workspaceId - The workspace id
 * @return {Object} The filter object
*/
export const tenantUserIdFilter = (
	userId: string | ObjectId,
	workspaceId: ObjectId,
): { _id: ObjectId; workspaceId: ObjectId } => {
	const id = userId instanceof ObjectId ? userId : new ObjectId(userId.toString());

	return {
		_id: id,
		workspaceId,
	};
};

export const isWorkspaceAdmin = (cognitoGroups: string[]): boolean => cognitoGroups.includes('admin');
