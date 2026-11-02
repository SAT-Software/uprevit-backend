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
 * Checks an import file against the workspace: used plan numbers, existing departments and projects, taken project numbers
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
		const projectNumbers = input?.project_numbers ?? [];
		const destinations = input?.destinations ?? [];
		if (!isStringList(planNumbers) || !isStringList(projectNumbers)) {
			return ResponseWrapper.badRequest(`plan_numbers and project_numbers must be lists of at most ${MAX_ITEMS} strings`);
		}
		if (!Array.isArray(destinations) || destinations.length > MAX_ITEMS ||
			destinations.some((item) => typeof item?.department_name !== 'string' || typeof item?.project_name !== 'string')) {
			return ResponseWrapper.badRequest('destinations must be a list of department and project names');
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

		const departmentIds = new Map<string, string[]>();
		for (const department of departments) {
			const key = nameKey(department.department_name);
			departmentIds.set(key, [...(departmentIds.get(key) ?? []), department._id!.toString()]);
		}
		const projectsByNumber = new Map(projects.map((project) => [project.project_number?.trim(), project.project_name]));
		const projectsByName = new Map<string, Project[]>();
		for (const project of projects) {
			const key = `${project.department_id?.toString()}\n${nameKey(project.project_name)}`;
			projectsByName.set(key, [...(projectsByName.get(key) ?? []), project]);
		}

		return ResponseWrapper.success({
			existing_plan_numbers: planNumbers.filter((value) => usedPlanNumbers.has(nameKey(value))),
			taken_project_numbers: projectNumbers
				.filter((value) => projectsByNumber.has(value.trim()))
				.map((value) => ({ project_number: value, project_name: projectsByNumber.get(value.trim()) })),
			destinations: destinations.map(({ department_name: departmentName, project_name: projectName }) => {
				const matchingDepartments = departmentIds.get(nameKey(departmentName)) ?? [];
				const departmentId = matchingDepartments.length === 1 ? matchingDepartments[0] : null;
				const matches = departmentId && projectName.trim() ? projectsByName.get(`${departmentId}\n${nameKey(projectName)}`) ?? [] : [];
				const project = matches.length === 1 ? matches[0] : undefined;
				return {
					department_name: departmentName,
					project_name: projectName,
					department_exists: matchingDepartments.length > 0,
					ambiguous: matchingDepartments.length > 1 || matches.length > 1,
					project: project ? { _id: project._id!.toString(), project_name: project.project_name, project_number: project.project_number } : null,
				};
			}),
		});
	} catch (err) {
		logError('Check product import handler failed', err);
		return ResponseWrapper.internalServerError('Failed to check the import');
	}
});
