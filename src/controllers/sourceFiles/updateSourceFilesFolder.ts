import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";

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

		const updatedFolder = await sourceFilesCollection.findOneAndUpdate(
			{ _id: folderObjectId, type: 'folder' },
			{ $set: updateFields },
			{ returnDocument: 'after' }
		);

		if (!updatedFolder) {
			return ResponseWrapper.notFound('Folder not found.');
		}

		await updateAuditLog({
			entity: 'SourceFile',
			entityId: folderId,
			action: AuditLogAction.UPDATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({
			message: 'Source file folder updated successfully.',
			result: updatedFolder
		})
        
	} catch (error) {
		console.error('Error while update the source files folder name:', error);
		return ResponseWrapper.internalServerError(error instanceof Error ? error.message : 'Something went wrong while updating source file folder.');
	}
}