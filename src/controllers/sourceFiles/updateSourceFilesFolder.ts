import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { recordAuditEvent } from "../../utils/auditLogV2";

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

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

		const  validateFolderId = validateAllObjectIds({
			folderId,
			...(typeof input.product_id === 'string' && { product_id: input.product_id })
		});
		if (validateFolderId) return validateFolderId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const folderObjectId = new ObjectId(folderId);
		const updateFields: Partial<SourceFile> = {};

		if (hasName) {
			const trimmedFolderName = input.name.trim();
			if (!trimmedFolderName) return ResponseWrapper.badRequest('Folder name cannot be empty.');
			updateFields.name = trimmedFolderName;
		}

		if (hasProductId) {
			const folder = await sourceFilesCollection.findOne({ _id: folderObjectId, type: 'folder' });
			if (!folder) {
				return ResponseWrapper.notFound('Folder not found.');
			}
			if (folder.parentId) {
				return ResponseWrapper.badRequest('product_id can only be set on top-level folders.');
			}
			updateFields.product_id = typeof input.product_id === 'string'
				? ObjectId.createFromHexString(input.product_id)
				: null;
		}

		const beforeFolder = await sourceFilesCollection.findOne({ _id: folderObjectId, type: 'folder' });

		const updatedFolder = await sourceFilesCollection.findOneAndUpdate(
			{ _id: folderObjectId, type: 'folder' },
			{ $set: updateFields },
			{ returnDocument: 'after' }
		);

		if (!updatedFolder) {
			return ResponseWrapper.notFound('Folder not found.');
		}

		const hasNameChange = Object.prototype.hasOwnProperty.call(updateFields, 'name');
		const hasProductChange = Object.prototype.hasOwnProperty.call(updateFields, 'product_id');

		const auditEvents: Array<{
			action: 'update' | 'link' | 'unlink';
			eventKey: string;
			changedPaths: string[];
			meta: Record<string, unknown>;
		}> = [];

		if (hasNameChange) {
			auditEvents.push({
				action: 'update',
				eventKey: 'source_files.folder.renamed',
				changedPaths: ['name'],
				meta: {
					folderName: updatedFolder.name,
					fromName: beforeFolder?.name,
					toName: updatedFolder.name,
				},
			});
		}

		if (hasProductChange) {
			auditEvents.push({
				action: updateFields.product_id ? 'link' : 'unlink',
				eventKey: updateFields.product_id
					? 'source_files.folder.product_linked'
					: 'source_files.folder.product_unlinked',
				changedPaths: ['product_id'],
				meta: {
					folderName: updatedFolder.name,
					fromProductId: beforeFolder?.product_id?.toString() ?? null,
					toProductId: updatedFolder.product_id?.toString() ?? null,
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
				before: beforeFolder as unknown as Record<string, unknown>,
				after: updatedFolder as unknown as Record<string, unknown>,
				changedPaths: auditEvent.changedPaths,
				meta: auditEvent.meta,
			});
		}

		return ResponseWrapper.success({
			message: 'Source file folder updated successfully.',
			result: updatedFolder
		})
        
	} catch (error) {
		logError('Update source files folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to update source file folder');
	}
}
