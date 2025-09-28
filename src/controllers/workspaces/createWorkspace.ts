import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Workspace } from '../../models/workspace';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { validateRole } from '../../utils/authUtils';
import { validateMissingFields } from '../../utils/validationUtils';


/**
 * API endpoint to create a workspace - only admin can create a workspace
 * @param event - API Gateway Lambda Proxy Input Format
 * @returns 
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const authHeader = event.headers?.Authorization || event.headers?.authorization;

		if(!authHeader) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		const token = authHeader.split(' ')[1];

		const { isValid, payload } = await validateRole(token, 'admin');

		if(!isValid) {
			return ResponseWrapper.unauthorized('Unauthorized');
		}

		// Parse the request body from the event
		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		const input: Workspace = JSON.parse(event.body);

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
			planStart: input.planStart || new Date(),
			planEnd: input.planEnd || new Date(),
			cost: input.cost || 0,
			userIds: input.userIds || []
		});

		await updateAuditLog({
			entity: 'workspace',
			entityId: workspace.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Workspace created successfully',
			workspace: workspace,
		});
		
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
