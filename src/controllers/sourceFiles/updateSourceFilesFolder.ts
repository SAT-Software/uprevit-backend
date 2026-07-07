import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext, tenantObjectIdFilter } from '../../utils/tenantContext';
import { getDb } from '../../utils/db';
import { validateAllObjectIds } from '../../utils/validationUtils';
import { ObjectId } from 'mongodb';
import { SourceFile } from '../../models/sourceFiles';
import type { AuditLogV2Change } from '../../models/auditLogV2';
import { recordAuditEvent } from '../../utils/auditLogV2';
import { resolveWorkspaceProductName } from '../../utils/sourceFilesAudit';

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const folderId = event.pathParameters?.folderId;
		if (!folderId) return ResponseWrapper.badRequest('Missing required path parameter: folderId');

		const input = JSON.parse(event.body);

		const hasName = typeof input.name === 'string';
		const hasProductId = Object.prototype.hasOwnProperty.call(input, 'product_id');

		if (!hasName && !hasProductId) {
			return ResponseWrapper.badRequest('At least one of name or product_id is required.');
		}

		if (hasProductId && input.product_id !== null && typeof input.product_id !== 'string') {
			return ResponseWrapper.badRequest('product_id must be a valid ObjectId string or null.');
		}

		const validateFolderId = validateAllObjectIds({
			folderId,
			...(typeof input.product_id === 'string' && { product_id: input.product_id }),
		});
		if (validateFolderId) return validateFolderId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const folderFilter = {
			...tenantObjectIdFilter(folderId, context.workspaceId),
			type: 'folder' as const,
		};

		const beforeFolder = await sourceFilesCollection.findOne(folderFilter);
		if (!beforeFolder) {
			return ResponseWrapper.notFound('Folder not found.');
		}

		const updateFields: Partial<SourceFile> = {};

		if (hasName) {
			const trimmedFolderName = input.name.trim();
			if (!trimmedFolderName) return ResponseWrapper.badRequest('Folder name cannot be empty.');
			if (trimmedFolderName !== beforeFolder.name) {
				updateFields.name = trimmedFolderName;
			}
		}

		if (hasProductId) {
			if (beforeFolder.parentId) {
				return ResponseWrapper.badRequest('product_id can only be set on top-level folders.');
			}

			const nextProductId = typeof input.product_id === 'string' ? input.product_id : null;
			const currentProductId = beforeFolder.product_id?.toString() ?? null;

			if (nextProductId !== currentProductId) {
				updateFields.product_id = nextProductId
					? ObjectId.createFromHexString(nextProductId)
					: null;
			}
		}

		if (!Object.keys(updateFields).length) {
			return ResponseWrapper.success({
				message: 'Source file folder updated successfully.',
				result: beforeFolder,
			});
		}

		const updatedFolder = await sourceFilesCollection.findOneAndUpdate(
			folderFilter,
			{ $set: updateFields },
			{ returnDocument: 'after' },
		);

		if (!updatedFolder) {
			return ResponseWrapper.notFound('Folder not found.');
		}

		const auditEvents: Array<{
			action: 'update' | 'link' | 'unlink';
			eventKey: string;
			changes: AuditLogV2Change[];
			meta: Record<string, unknown>;
		}> = [];

		if (Object.prototype.hasOwnProperty.call(updateFields, 'name')) {
			auditEvents.push({
				action: 'update',
				eventKey: 'source_files.folder.renamed',
				changes: [{
					path: 'name',
					from: beforeFolder.name,
					to: updatedFolder.name,
				}],
				meta: {
					folderName: updatedFolder.name,
					fromName: beforeFolder.name,
					toName: updatedFolder.name,
				},
			});
		}

		if (Object.prototype.hasOwnProperty.call(updateFields, 'product_id')) {
			const fromProductName = await resolveWorkspaceProductName(
				db,
				beforeFolder.product_id,
				context.workspaceId,
			);
			const toProductName = await resolveWorkspaceProductName(
				db,
				updatedFolder.product_id,
				context.workspaceId,
			);

			auditEvents.push({
				action: updatedFolder.product_id ? 'link' : 'unlink',
				eventKey: updatedFolder.product_id
					? 'source_files.folder.product_linked'
					: 'source_files.folder.product_unlinked',
				changes: [{
					path: 'product',
					from: fromProductName,
					to: toProductName,
				}],
				meta: {
					folderName: updatedFolder.name,
					fromProductName,
					toProductName,
				},
			});
		}

		for (const auditEvent of auditEvents) {
			await recordAuditEvent({
				workspaceId: updatedFolder.workspace_id.toString(),
				scope: { type: 'source-files', id: updatedFolder.workspace_id.toString() },
				entity: { type: 'source_folder', id: folderId },
				action: auditEvent.action,
				eventKey: auditEvent.eventKey,
				visibility: 'all',
				where: {
					module: 'source-files',
					parentId: updatedFolder.parentId?.toString() ?? undefined,
				},
				auth: auth.payload,
				changes: auditEvent.changes,
				meta: auditEvent.meta,
			});
		}

		return ResponseWrapper.success({
			message: 'Source file folder updated successfully.',
			result: updatedFolder,
		});
	} catch (error) {
		logError('Update source files folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update source file folder');
	}
};
