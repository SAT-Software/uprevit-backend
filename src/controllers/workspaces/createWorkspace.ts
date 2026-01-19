import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Workspace } from '../../models/workspace';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateMissingFields } from '../../utils/validationUtils';
import { authenticateWithRole } from '../../utils/authUtils';
import { logError } from '../../utils/logger';


/**
 * API endpoint to create a workspace - only admin can create a workspace
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format 
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateWithRole(event, 'admin');

		if(!auth.isValid) {
			return auth.error;
		}

		
		let input: Workspace;
		
		try {
			input = JSON.parse(event.body!);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const validationResult = validateMissingFields({
			'workspaceName': input.workspaceName,
			'companyName': input.companyName,
			'companyId': input.companyId,
		});
		
		if (validationResult) {
			return validationResult;
		}

		const db = await getDb();
		
		const workspace = await db.collection<Workspace>('workspaces').insertOne({
			workspaceName: input.workspaceName,
			companyName: input.companyName,
			companyId: input.companyId,
			description: input.description || '',
			logo: input.logo || '',
			plan: input.plan || '',
			planName: input.planName || '',
			planId: input.planId || '',
			planStart: input.planStart || null,
			planEnd: input.planEnd || null,
			cost: input.cost || 0,
			userIds: input.userIds || []
		});

		await updateAuditLog({
			entity: 'workspace',
			entityId: workspace.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Workspace created successfully',
			workspace: workspace,
		});
		
	} catch (err) {
		logError('Create workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to create workspace');
	}
};
