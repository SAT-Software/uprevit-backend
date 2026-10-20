import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { assertWorkspaceMatch, requireTenantContext } from '../../utils/tenantContext';

/**
 * API endpoint to get dashboard statistics for a workspace
 * @param event - API Gateway Lambda Proxy Input Format
 * @returns Dashboard statistics including counts for departments, projects, products, source files, and archives
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		const requestedWorkspaceId = event.queryStringParameters?.id;

		if (requestedWorkspaceId) {
			if (!ObjectId.isValid(requestedWorkspaceId)) {
				return ResponseWrapper.badRequest('Invalid workspace id');
			}

			const workspaceMismatch = assertWorkspaceMatch(requestedWorkspaceId, context.workspaceId);
			if (workspaceMismatch) return workspaceMismatch;
		}

		const db = await getDb();
		const workspaceObjectId = context.workspaceId;

		// Count departments for the workspace
		const departmentsPromise = db.collection('departments').countDocuments({
			workspace_id: workspaceObjectId,
			isArchived: false,
		});

		const sourceFilesPromise = db.collection('sourceFiles').countDocuments({
			workspace_id: workspaceObjectId,
			type: 'file',
		});

		const archivedDepartmentsPromise = db.collection('departments').countDocuments({
			workspace_id: workspaceObjectId,
			isArchived: true,
		});

		const archivedProjectsPromise = db.collection('projects').countDocuments({
			workspace_id: workspaceObjectId,
			isArchived: true,
		});

		const archivedProductsPromise = db.collection('products').countDocuments({
			workspace_id: workspaceObjectId,
			is_archived: true,
			is_latest: true,
		});

		const projectsPromise = db.collection('projects').countDocuments({
			workspace_id: workspaceObjectId,
			isArchived: false,
		});

		const productsPromise = db.collection('products').countDocuments({
			workspace_id: workspaceObjectId,
			is_archived: { $ne: true },
			is_latest: true,
		});

		const [
			totalDepartments,
			totalSourceFiles,
			archivedDepartments,
			archivedProjects,
			archivedProducts,
			totalProjects,
			totalProducts,
		] = await Promise.all([
			departmentsPromise,
			sourceFilesPromise,
			archivedDepartmentsPromise,
			archivedProjectsPromise,
			archivedProductsPromise,
			projectsPromise,
			productsPromise,
		]);

		return ResponseWrapper.success({
			message: 'Dashboard statistics retrieved successfully',
			data: {
				total_departments: totalDepartments,
				total_projects: totalProjects,
				total_products: totalProducts,
				total_source_files: totalSourceFiles,
				total_archives: archivedDepartments + archivedProjects + archivedProducts,
			},
		});
	} catch (err) {
		logError('Get dashboard stats handler failed', err);
		return ResponseWrapper.internalServerError('Failed to get dashboard stats');
	}
};
