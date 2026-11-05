import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import type { Department } from '../../models/department';
import type { Project } from '../../models/project';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';
import { findWorkspacePlanNumbers, nameKey } from '../../utils/productImport';

const MAX_ITEMS = 10000;

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => typeof item === 'string');

/**
 * Checks an import file against the workspace: used plan numbers, and existing projects matched by number or name
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const input = JSON.parse(event.body || '{}');
		const planNumbers = input?.plan_numbers;
		const projectValues = input?.projects ?? [];
		if (!isStringList(planNumbers) || !isStringList(projectValues)) {
			return ResponseWrapper.badRequest(`plan_numbers and projects must be lists of at most ${MAX_ITEMS} strings`);
		}

		const db = await getDb();
		const workspaceFilter = { workspace_id: context.workspaceId, isArchived: { $ne: true } };
		const [usedPlanNumbers, departments, projects] = await Promise.all([
			findWorkspacePlanNumbers(db, context.workspaceId),
			db.collection<Department>('departments').find(workspaceFilter, { projection: { department_name: 1 } }).toArray(),
			db.collection<Project>('projects').find(workspaceFilter, {
				projection: { project_name: 1, project_number: 1, department_id: 1 },
			}).toArray(),
		]);

		const departmentNames = new Map(departments.map((department) => [department._id!.toString(), department.department_name]));
		const byNumber = new Map<string, Project>();
		const byName = new Map<string, Project[]>();
		for (const project of projects) {
			if (!departmentNames.has(project.department_id?.toString())) continue;
			if (project.project_number?.trim()) byNumber.set(nameKey(project.project_number), project);
			const key = nameKey(project.project_name);
			byName.set(key, [...(byName.get(key) ?? []), project]);
		}

		return ResponseWrapper.success({
			existing_plan_numbers: planNumbers.filter((value) => usedPlanNumbers.has(nameKey(value))),
			projects: projectValues.map((value) => {
				const named = byName.get(nameKey(value)) ?? [];
				const project = byNumber.get(nameKey(value)) ?? (named.length === 1 ? named[0] : undefined);
				return {
					value,
					ambiguous: !project && named.length > 1,
					project: project ? {
						_id: project._id!.toString(),
						project_name: project.project_name,
						project_number: project.project_number,
						department_name: departmentNames.get(project.department_id.toString()),
					} : null,
				};
			}),
			// Released UI clients still read these lists; remove once they no longer do
			taken_project_numbers: [],
			destinations: [],
		});
	} catch (err) {
		logError('Check product import handler failed', err);
		return ResponseWrapper.internalServerError('Failed to check the import');
	}
});
