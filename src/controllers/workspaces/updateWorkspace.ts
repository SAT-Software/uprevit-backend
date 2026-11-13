import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { Workspace } from '../../models/workspace';
import { WORKFLOW_COMPLETION_MODES } from '../../models/workflow';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { normalizePersistedAssetReference } from '../../utils/s3-storage';
import { recordCommittedUploadIfNew } from '../../utils/billing/uploadCommit';
import { assertWorkspaceMatch, isWorkspaceAdmin, requireTenantContext } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';

/**
 * Update a workspace
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!isWorkspaceAdmin(context.cognitoGroups)) {
			return ResponseWrapper.forbidden('Insufficient permissions');
		}

		if (!event.body) {
			return ResponseWrapper.badRequest('Request body is required');
		}

		let input: Partial<Workspace>;
		
		try {
			input = JSON.parse(event.body!);
		} catch (error) {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		if (!input._id) {
			return ResponseWrapper.badRequest('Missing required fields: _id');
		}

		const objectIdsResult = validateAllObjectIds({
			'_id': input._id,
		});

		if (objectIdsResult) {
			return objectIdsResult;
		}

		const workspaceMismatch = assertWorkspaceMatch(input._id, context.workspaceId);
		if (workspaceMismatch) return workspaceMismatch;

		if (input.workspaceName !== undefined && (typeof input.workspaceName !== 'string' || !input.workspaceName.trim())) {
			return ResponseWrapper.badRequest('workspaceName must be a non-empty string');
		}

		const db = await getDb();

		const workspaceRecord: Workspace | null = await db.collection<Workspace>('workspaces').findOne({
			_id: context.workspaceId,
		});

		if (!workspaceRecord) {
			return ResponseWrapper.badRequest('Workspace not found');
		}

		const updateFields: Partial<Workspace> = {};
		for (const field of ['workspaceName', 'companyName', 'description'] as const) {
			if (input[field] !== undefined) updateFields[field] = input[field];
		}

		const normalizedLogo = input.logo === undefined
			? undefined
			: normalizePersistedAssetReference(input.logo, workspaceRecord.logo ?? '');
		if (normalizedLogo !== undefined) updateFields.logo = normalizedLogo;

		if (typeof input.memberListIncludeInactive === 'boolean') {
			updateFields.memberListIncludeInactive = input.memberListIncludeInactive;
		}

		if (input.defaultWorkflowCompletionMode !== undefined) {
			if (!WORKFLOW_COMPLETION_MODES.includes(input.defaultWorkflowCompletionMode)) {
				return ResponseWrapper.badRequest(`defaultWorkflowCompletionMode must be one of: ${WORKFLOW_COMPLETION_MODES.join(', ')}`);
			}
			updateFields.defaultWorkflowCompletionMode = input.defaultWorkflowCompletionMode;
		}

		if (input.supportReplayEnabled !== undefined) {
			if (typeof input.supportReplayEnabled !== 'boolean') {
				return ResponseWrapper.badRequest('supportReplayEnabled must be a boolean');
			}
			updateFields.supportReplayEnabled = input.supportReplayEnabled;
		}

		if (Object.keys(updateFields).length === 0) {
			return ResponseWrapper.badRequest('No workspace fields to update');
		}

		const workspace = await db.collection<Workspace>('workspaces').updateOne(
			{
				_id: context.workspaceId,
			},
			{
				$set: updateFields,
			},
		);

		await recordAuditEvent({
			workspaceId: context.workspaceId.toString(),
			scope: { type: 'workspace', id: context.workspaceId.toString() },
			entity: { type: 'workspace', id: context.workspaceId.toString() },
			action: 'update',
			eventKey: 'workspace.updated',
			visibility: 'admin',
			where: { module: 'workspace' },
			auth: auth.payload,
			before: { ...workspaceRecord },
			after: { ...workspaceRecord, ...updateFields },
			changedPaths: Object.keys(updateFields),
			meta: { workspaceName: updateFields.workspaceName ?? workspaceRecord.workspaceName },
		});

		if (normalizedLogo !== undefined) {
			await recordCommittedUploadIfNew({
				workspaceId: context.workspaceId,
				newKey: normalizedLogo,
				metadata: { assetType: 'workspace_logo' },
			});
		}

		return ResponseWrapper.success({
			message: 'Workspace updated successfully',
			workspace: workspace,
		});
	} catch (err) {
		logError('Update workspace handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update workspace');
	}
});
