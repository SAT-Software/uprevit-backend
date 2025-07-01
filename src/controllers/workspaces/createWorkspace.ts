import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		// Parse the request body from the event
		if (!event.body) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Request body is required',
				}),
			};
		}

		const input: Workspace = JSON.parse(event.body);

		// Validate required fields
		if (!input.workspaceName || !input.companyName || !input.companyId) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Missing required fields: workspace_name, company_name, and company_id are required',
				}),
			};
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
			actionBy: workspace.insertedId.toString(),
			actionAt: new Date(),
			active: true,
		});

		return {
			statusCode: 201,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Workspace created successfully',
				workspace: workspace,
			}),
		};
	} catch (err) {
		console.error('Error in Lambda handler:', err);
		return {
			statusCode: 500,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Internal server error',
				error: err instanceof Error ? err.message : 'Unknown error',
				timestamp: new Date().toISOString(),
			}),
		};
	}
};
