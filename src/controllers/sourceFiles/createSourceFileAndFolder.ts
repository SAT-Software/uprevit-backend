import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds, validateEnum, validateMissingFields } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { SourceFile } from "../../models/sourceFiles";
import { ObjectId } from "mongodb";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		if (!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			workspace_id: input.workspace_id,
			name: input.name,
			type: input.type,
			...(input.type === 'file' && { url: input.url })
		});
		if (missingFieldsResult) return missingFieldsResult;

		const isValidEnum = validateEnum(['file', 'folder'], input.type)
		if(isValidEnum) return isValidEnum

		const objectIdValidation = validateAllObjectIds({
			workspace_id: input.workspace_id,
			...(input.parentId && { 'parentId': input.parentId }),
			...(input.product_id && { 'product_id': input.product_id })
		});
		if (objectIdValidation) return objectIdValidation;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const workspaceId = ObjectId.createFromHexString(input.workspace_id);
		const parentId = input.parentId ? ObjectId.createFromHexString(input.parentId) : null;
		const productId = typeof input.product_id === 'string' ? ObjectId.createFromHexString(input.product_id) : null;

		if (productId && input.type !== 'folder') {
			return ResponseWrapper.badRequest('product_id can only be set for folders.');
		}

		if (productId && parentId) {
			return ResponseWrapper.badRequest('product_id can only be set on top-level folders.');
		}

		const trimmedName = input.name.trim();

		if (parentId) {
			const parentFolder = await sourceFilesCollection.findOne({
				_id: parentId,
				workspace_id: workspaceId,
				type: 'folder'
			});
			if (!parentFolder) return ResponseWrapper.badRequest('Parent folder not found or is not a folder.');
		}

		const existingFileOrFolder = await sourceFilesCollection.findOne({
			workspace_id: workspaceId,
			parentId: parentId,
			name: trimmedName,
		});

		if (existingFileOrFolder) return ResponseWrapper.conflict(`A ${existingFileOrFolder.type} with the same name already exists in this location.`);


		const newSourceFile: SourceFile = {
			_id: new ObjectId(),
			workspace_id: workspaceId,
			name: trimmedName,
			type: input.type,
			parentId: parentId,
			...(input.type === 'folder' && productId && { product_id: productId }),
			...(input.type === 'file' && {url: input.url})
		};

		await sourceFilesCollection.insertOne(newSourceFile);

		await updateAuditLog({
			entity: 'SourceFile',
			entityId: newSourceFile._id.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: input.type === 'file'  ? 'Source file created successfully.' : 'Source folder created successfully.',
			folder: newSourceFile
		});
	} catch (error) {
		logError('Create source file/folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create source file or folder');
	}
}