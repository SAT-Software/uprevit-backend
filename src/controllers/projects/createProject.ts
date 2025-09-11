import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Project } from '../../models/project';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';

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

		type ProjectInput = {
			workspace_id: string;
			department_id: string;
			project_name: string;
			project_description: string;
			manager?: string;
			admin_id: string;
		};

		const input: ProjectInput = JSON.parse(event.body);

		if (!input.workspace_id || !input.department_id || !input.project_name || !input.project_description || !input.admin_id) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Missing required fields: workspace_id, department_id, project_name, project_description, and admin_id are required',
				}),
			};
		}

		// Validate ObjectId formats
		if (!ObjectId.isValid(input.workspace_id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid workspace_id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		if (!ObjectId.isValid(input.department_id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid department_id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		if (!ObjectId.isValid(input.admin_id)) {
			return {
				statusCode: 400,
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: 'Invalid admin_id format. Must be a valid MongoDB ObjectId.',
				}),
			};
		}

		const db = await getDb();
		
		const workspaceObjectId = new ObjectId(input.workspace_id);
		const departmentObjectId = new ObjectId(input.department_id);
		const adminObjectId = new ObjectId(input.admin_id);


		const project = await db.collection<Project>('projects').insertOne({
			workspace_id: workspaceObjectId,
			department_id: departmentObjectId,
			project_name: input.project_name,
			project_description: input.project_description,
			manager: input.manager,
			admin_id: adminObjectId,
			isArchived: false,
		});

		await updateAuditLog({
			entity: 'project',
			entityId: project.insertedId.toString(),
			action: AuditLogAction.CREATE,
			actionBy: input.admin_id,
			actionAt: new Date(),
			active: true,
		});

		return {
			statusCode: 201,
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'Project created successfully',
				project: project,
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