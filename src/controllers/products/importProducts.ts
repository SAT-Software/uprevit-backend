import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { type Db, MongoBulkWriteError, ObjectId } from 'mongodb';
import { getDb } from '../../utils/db';
import type { Product } from '../../models/product';
import type { Project } from '../../models/project';
import type { Department } from '../../models/department';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';
import {
	acquireImportLock,
	buildImportedProduct,
	exactName,
	findWorkspacePlanNumbers,
	type ImportProductInput,
	MAX_IMPORT_PRODUCTS,
	nameKey,
	releaseImportLock,
	validateImportProduct,
} from '../../utils/productImport';

type ImportResult = { plan_number: string; status: 'created' | 'failed'; product_id?: string; error?: string };
type AuditAuth = Parameters<typeof recordAuditEvent>[0]['auth'];

const findOrCreateDepartment = async (
	db: Db,
	workspaceId: ObjectId,
	userId: ObjectId,
	name: string,
	auth: AuditAuth,
): Promise<{ id?: ObjectId; error?: string }> => {
	const departments = db.collection<Department>('departments');
	const existing = await departments.find({
		workspace_id: workspaceId,
		department_name: exactName(name),
		isArchived: { $ne: true },
	}).limit(2).toArray();
	if (existing.length > 1) return { error: `More than one department is named ${name.trim()}. Assign the project in the review.` };
	if (existing[0]?._id) return { id: existing[0]._id };

	const department = { department_name: name.trim(), department_description: '', image: '', admin_id: userId, workspace_id: workspaceId, users: [], isArchived: false };
	const { insertedId } = await departments.insertOne(department);
	await recordAuditEvent({
		workspaceId: workspaceId.toString(),
		scope: { type: 'department', id: insertedId.toString() },
		entity: { type: 'department', id: insertedId.toString() },
		action: 'create',
		eventKey: 'department.created',
		visibility: 'admin',
		where: { module: 'departments' },
		auth,
		after: { department_name: department.department_name, department_description: '' },
		changedPaths: ['department_name', 'department_description'],
		meta: { departmentName: department.department_name, source: 'product_import' },
	});
	return { id: insertedId };
};

const findOrCreateProject = async (
	db: Db,
	workspaceId: ObjectId,
	userId: ObjectId,
	target: NonNullable<ImportProductInput['new_project']>,
	auth: AuditAuth,
): Promise<{ project?: Project; error?: string }> => {
	const projects = db.collection<Project>('projects');
	const department = await findOrCreateDepartment(db, workspaceId, userId, target.department_name, auth);
	if (!department.id) return { error: department.error };
	const departmentId = department.id;
	const existing = await projects.find({
		workspace_id: workspaceId,
		department_id: departmentId,
		project_name: exactName(target.project_name),
		isArchived: { $ne: true },
	}).limit(2).toArray();
	if (existing.length > 1) return { error: `More than one project is named ${target.project_name.trim()} in this department. Assign the project in the review.` };
	if (existing.length) return { project: existing[0] };

	const projectNumber = target.project_number.trim();
	const numberTaken = await projects.findOne({ workspace_id: workspaceId, project_number: projectNumber, isArchived: { $ne: true } });
	if (numberTaken) return { error: `Project number ${projectNumber} is already used by project ${numberTaken.project_name}` };

	const project: Project = {
		workspace_id: workspaceId,
		department_id: departmentId,
		project_name: target.project_name.trim(),
		project_number: projectNumber,
		project_description: '',
		admin_id: userId,
		users: [],
		isArchived: false,
		image: '',
	};
	const { insertedId } = await projects.insertOne(project);
	await recordAuditEvent({
		workspaceId: workspaceId.toString(),
		scope: { type: 'project', id: insertedId.toString() },
		entity: { type: 'project', id: insertedId.toString() },
		action: 'create',
		eventKey: 'project.created',
		visibility: 'admin',
		where: { module: 'projects' },
		auth,
		after: { project_name: project.project_name, project_number: projectNumber, project_description: '' },
		changedPaths: ['project_name', 'project_number', 'project_description'],
		meta: { projectName: project.project_name, source: 'product_import' },
	});
	return { project: { ...project, _id: insertedId } };
};

/**
 * Creates Draft products from an import file, creating departments and projects that don't exist yet
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;
		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const input = JSON.parse(event.body || '{}');
		const products: ImportProductInput[] = input?.products;
		if (!Array.isArray(products) || !products.length) return ResponseWrapper.badRequest('products must be a non-empty list');
		if (products.length > MAX_IMPORT_PRODUCTS) {
			return ResponseWrapper.badRequest(`Send at most ${MAX_IMPORT_PRODUCTS} products per request`);
		}

		const db = await getDb();
		const { workspaceId, userId } = context;
		if (!(await acquireImportLock(db, workspaceId))) {
			return ResponseWrapper.conflict('Another product import is running in this workspace. Try again in a moment.');
		}

		try {
			const results: ImportResult[] = products.map((product) => ({
				plan_number: typeof product?.product_plan_number === 'string' ? product.product_plan_number.trim() : '',
				status: 'failed',
			}));
			const fail = (index: number, error: string) => { results[index].error = error; };

			const usedPlanNumbers = await findWorkspacePlanNumbers(db, workspaceId);
			products.forEach((product, index) => {
				const error = validateImportProduct(product);
				if (error) return fail(index, error);
				const key = nameKey(product.product_plan_number);
				if (usedPlanNumbers.has(key)) return fail(index, 'A product with this plan number already exists in this workspace');
				usedPlanNumbers.add(key);
			});

			const projectIds = [...new Set(products.filter((product, index) => !results[index].error && product.project_id)
				.map((product) => product.project_id as string))];
			const existingProjects = projectIds.length ? await db.collection<Project>('projects').find({
				_id: { $in: projectIds.map((id) => new ObjectId(id)) },
				workspace_id: workspaceId,
				isArchived: { $ne: true },
			}).toArray() : [];
			const projectsById = new Map(existingProjects.map((project) => [project._id!.toString(), project]));

			const newProjects = new Map<string, { project?: Project; error?: string }>();
			const documents: Array<{ index: number; product: Product }> = [];
			for (const [index, product] of products.entries()) {
				if (results[index].error) continue;
				let project: Project | undefined;
				if (product.project_id) {
					project = projectsById.get(product.project_id);
					if (!project) {
						fail(index, 'The assigned project no longer exists or is archived');
						continue;
					}
				} else {
					const target = product.new_project!;
					const key = `${nameKey(target.department_name)}\n${nameKey(target.project_name)}`;
					if (!newProjects.has(key)) newProjects.set(key, await findOrCreateProject(db, workspaceId, userId, target, auth.payload));
					const resolved = newProjects.get(key)!;
					if (!resolved.project) {
						fail(index, resolved.error!);
						continue;
					}
					project = resolved.project;
				}
				documents.push({
					index,
					product: buildImportedProduct(product, {
						workspaceId,
						projectId: project._id!,
						departmentId: project.department_id,
						ownerId: userId,
					}),
				});
			}

			const failedInserts = new Set<number>();
			if (documents.length) {
				try {
					await db.collection<Product>('products').insertMany(documents.map((item) => item.product), { ordered: false });
				} catch (error) {
					if (!(error instanceof MongoBulkWriteError)) throw error;
					const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
					writeErrors.forEach((writeError) => failedInserts.add(writeError.index));
				}
			}

			for (const [position, { index, product }] of documents.entries()) {
				if (failedInserts.has(position)) {
					fail(index, 'The product could not be created');
					continue;
				}
				const productId = product._id!.toString();
				Object.assign(results[index], { status: 'created', product_id: productId });
				await recordAuditEvent({
					workspaceId: workspaceId.toString(),
					scope: { type: 'product', id: productId },
					entity: { type: 'product', id: productId },
					action: 'create',
					eventKey: 'product.created',
					visibility: 'all',
					where: { module: 'products' },
					auth: auth.payload,
					after: {
						product_plan_number: product.product_plan_number,
						product_name: product.product_name,
						product_description: product.product_description,
						status: product.status,
						version: product.version,
					},
					changedPaths: ['product_plan_number', 'product_name', 'product_description', 'status', 'version'],
					meta: { productName: product.product_name, source: 'product_import' },
				});
			}

			return ResponseWrapper.success({ results });
		} finally {
			await releaseImportLock(db, workspaceId);
		}
	} catch (err) {
		logError('Import products handler failed', err);
		return ResponseWrapper.internalServerError('Failed to import products');
	}
});
