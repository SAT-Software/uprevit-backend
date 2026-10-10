import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId, type Filter, type UpdateFilter } from 'mongodb';
import type { Product } from '../../models/product';
import { ACTIVE_WORKFLOW_STATUSES, WORKFLOWS_COLLECTION, type Workflow, type WorkflowAssignment } from '../../models/workflow';
import { logError } from '../../utils/logger';
import { findActiveWorkspaceMember } from '../../utils/productAccess';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { parseJsonObject, parseWorkflowDetails } from '../../utils/workflowInput';
import {
	PRODUCT_STATUS_LABELS,
	WORKFLOW_EDIT_FORBIDDEN_MESSAGE,
	WORKFLOW_NOT_DRAFT_MESSAGE,
	canManageWorkflow,
	findWorkflow,
	getProductTeam,
	lineageIdOf,
	requireWorkflowContext,
} from '../../utils/workflows';

const ACTIONS = ['update-details', 'add-product', 'remove-product', 'add-assignment', 'remove-assignment'] as const;
type Action = typeof ACTIONS[number];

const FUNCTION_LABEL_MAX_LENGTH = 60;
const PRODUCT_TEAM_LABEL = 'Product Team';

const toObjectId = (value: unknown) => typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null;

type Change = {
	filter?: Filter<Workflow>;
	update: UpdateFilter<Workflow>;
	conflictMessage?: string;
	requiredProduct?: { lineageId: ObjectId; name: string };
} | { error: APIGatewayProxyResult };

/**
 * Changes a Draft workflow's details, Products or approver assignments. Only the Initiator or an admin may do this.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const workflowResult = await requireWorkflowContext(event);
		if (!workflowResult.ok) return workflowResult.response;

		const { context, db } = workflowResult;
		if (!event.body) return ResponseWrapper.badRequest('Request body is required');
		const input = parseJsonObject(event.body);
		if (!input) return ResponseWrapper.badRequest('Request body must be a JSON object');
		const action = input.action as Action;
		if (!ACTIONS.includes(action)) return ResponseWrapper.badRequest(`Invalid action. Must be one of: ${ACTIONS.join(', ')}`);

		const workflow = await findWorkflow(db, context.workspaceId, event.pathParameters?.workflowId);
		if (!workflow) return ResponseWrapper.notFound('Workflow not found');
		if (!canManageWorkflow(context, workflow)) return ResponseWrapper.forbidden(WORKFLOW_EDIT_FORBIDDEN_MESSAGE);
		if (workflow.status !== 'draft') return ResponseWrapper.conflict(WORKFLOW_NOT_DRAFT_MESSAGE);

		const products = db.collection<Product>('products');
		const workflows = db.collection<Workflow>(WORKFLOWS_COLLECTION);

		const buildChange = async (): Promise<Change> => {
			switch (action) {
			case 'update-details': {
				const details = parseWorkflowDetails(input, { required: false });
				if ('error' in details) return { error: ResponseWrapper.badRequest(details.error) };
				if (Object.keys(details.value).length === 0) {
					return { error: ResponseWrapper.badRequest('Provide a name, description, or completionMode') };
				}
				return { update: { $set: details.value } };
			}

			case 'add-product': {
				const productId = toObjectId(input.productId);
				if (!productId) return { error: ResponseWrapper.badRequest('A valid productId is required') };

				const product = await products.findOne(
					{ _id: productId, workspace_id: context.workspaceId },
					{ projection: { product_lineage_id: 1, product_name: 1, product_plan_number: 1, version: 1, status: 1, is_latest: 1, is_archived: 1 } },
				);
				if (!product) return { error: ResponseWrapper.notFound('Product not found') };

				const lineageId = lineageIdOf(product);
				if (product.is_archived) return { error: ResponseWrapper.badRequest(`${product.product_name} is archived. Restore it first.`) };
				if (!product.is_latest) return { error: ResponseWrapper.badRequest(`${product.product_name} has a newer version. Add the latest version.`) };
				if (product.status === 'released' || product.status === 'obsolete') {
					return { error: ResponseWrapper.badRequest(`${product.product_name} is ${PRODUCT_STATUS_LABELS[product.status]}. Create a new version to include it in a workflow.`) };
				}
				if (workflow.products.some((item) => item.lineageId.equals(lineageId))) {
					return { error: ResponseWrapper.conflict(`${product.product_name} is already in this workflow`) };
				}
				const activeWorkflow = await workflows.findOne(
					{ 'workspaceId': context.workspaceId, 'status': { $in: ACTIVE_WORKFLOW_STATUSES }, 'products.lineageId': lineageId },
					{ projection: { numberLabel: 1 } },
				);
				if (activeWorkflow || product.status === 'in_review') {
					return { error: ResponseWrapper.conflict(`${product.product_name} is already in review${activeWorkflow ? ` in ${activeWorkflow.numberLabel}` : ''}`) };
				}

				return {
					filter: { 'products.lineageId': { $ne: lineageId } },
					update: {
						$push: {
							products: {
								lineageId,
								productVersionId: product._id!,
								name: product.product_name,
								planNumber: product.product_plan_number,
								version: product.version,
							},
						},
					},
					conflictMessage: `${product.product_name} is already in this workflow`,
				};
			}

			case 'remove-product': {
				const lineageId = toObjectId(input.lineageId);
				if (!lineageId) return { error: ResponseWrapper.badRequest('A valid lineageId is required') };
				if (!workflow.products.some((item) => item.lineageId.equals(lineageId))) {
					return { error: ResponseWrapper.badRequest('This Product is not in the workflow') };
				}
				return { update: { $pull: { products: { lineageId }, assignments: { lineageId } } } };
			}

			case 'add-assignment': {
				const member = await findActiveWorkspaceMember(db, context.workspaceId, input.userId);
				if (!member) return { error: ResponseWrapper.badRequest('The approver must be an active member of this workspace') };
				const userId = member._id!;
				const base = {
					_id: new ObjectId(),
					userId,
					userSnapshot: { name: member.name, email: member.email },
					decision: 'pending' as const,
				};

				let assignment: WorkflowAssignment;
				let requiredProduct: { lineageId: ObjectId; name: string } | undefined;
				if (input.functionType === 'product_team') {
					const lineageId = toObjectId(input.lineageId);
					const product = lineageId && workflow.products.find((item) => item.lineageId.equals(lineageId));
					if (!lineageId || !product) return { error: ResponseWrapper.badRequest('Pick a Product in this workflow') };

					const latest = await products.findOne(
						{ workspace_id: context.workspaceId, is_latest: true, $or: [{ product_lineage_id: lineageId }, { _id: lineageId, product_lineage_id: { $exists: false } }] },
						{ projection: { owner_user_id: 1, contributor_user_ids: 1 } },
					);
					const teamMember = latest && (await getProductTeam(db, context.workspaceId, latest)).find((item) => item._id.equals(userId));
					if (!teamMember) {
						return { error: ResponseWrapper.badRequest(`Only the Product Owner or Contributors of ${product.name} can approve for its Product Team`) };
					}
					assignment = { ...base, functionType: 'product_team', functionLabel: PRODUCT_TEAM_LABEL, lineageId, relationship: teamMember.relationship };
					requiredProduct = { lineageId, name: product.name };
				} else if (input.functionType === 'function') {
					const functionLabel = typeof input.functionLabel === 'string' ? input.functionLabel.trim().replace(/\s+/g, ' ') : '';
					if (!functionLabel) return { error: ResponseWrapper.badRequest('A Function name is required') };
					if (functionLabel.length > FUNCTION_LABEL_MAX_LENGTH) {
						return { error: ResponseWrapper.badRequest(`Function name must be at most ${FUNCTION_LABEL_MAX_LENGTH} characters`) };
					}
					if (functionLabel.toLowerCase() === PRODUCT_TEAM_LABEL.toLowerCase()) {
						return { error: ResponseWrapper.badRequest('Product Team is set per Product. Use a different Function name.') };
					}
					assignment = { ...base, functionType: 'function', functionLabel };
				} else {
					return { error: ResponseWrapper.badRequest('functionType must be product_team or function') };
				}

				const duplicate = assignment.functionType === 'product_team'
					? { functionType: 'product_team', lineageId: assignment.lineageId, userId }
					: { functionType: 'function', functionLabel: { $regex: `^${assignment.functionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, userId };
				return {
					filter: {
						assignments: { $not: { $elemMatch: duplicate } },
						...(requiredProduct && { 'products.lineageId': requiredProduct.lineageId }),
					},
					update: { $push: { assignments: assignment } },
					conflictMessage: `${member.name} is already assigned here`,
					requiredProduct,
				};
			}

			case 'remove-assignment': {
				const assignmentId = toObjectId(input.assignmentId);
				if (!assignmentId) return { error: ResponseWrapper.badRequest('A valid assignmentId is required') };
				return {
					filter: { 'assignments._id': assignmentId },
					update: { $pull: { assignments: { _id: assignmentId } } },
					conflictMessage: 'This approver was already removed',
				};
			}
			}
		};

		const change = await buildChange();
		if ('error' in change) return change.error;

		const updated = await workflows.findOneAndUpdate(
			{ _id: workflow._id, workspaceId: context.workspaceId, status: 'draft', ...change.filter },
			change.update,
			{ returnDocument: 'after' },
		);
		if (!updated) {
			const current = await workflows.findOne({ _id: workflow._id }, { projection: { 'status': 1, 'products.lineageId': 1 } });
			if (!current) return ResponseWrapper.notFound('Workflow not found');
			if (current.status !== 'draft') return ResponseWrapper.conflict(WORKFLOW_NOT_DRAFT_MESSAGE);
			const { requiredProduct } = change;
			if (requiredProduct && !current.products.some((item) => item.lineageId.equals(requiredProduct.lineageId))) {
				return ResponseWrapper.conflict(`${requiredProduct.name} was removed from this workflow. Reload and try again.`);
			}
			return ResponseWrapper.conflict(change.conflictMessage ?? 'The workflow changed. Reload and try again.');
		}

		return ResponseWrapper.success({ message: 'Workflow updated successfully', action, workflow: updated });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON in request body');
		logError('Update workflow handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update workflow');
	}
};
