import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
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
		});
		if (missingFieldsResult) return missingFieldsResult;

		const isValidEnum = validateEnum(['file', 'folder'], input.type)
		if(isValidEnum) return isValidEnum

		const objectIdValidation = validateAllObjectIds({
			workspace_id: input.workspace_id,
			...(input.parentId && { 'parentId': input.parentId })
		});
		if (objectIdValidation) return objectIdValidation;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const workspaceId = ObjectId.createFromHexString(input.workspace_id);
		const parentId = input.parentId ? ObjectId.createFromHexString(input.parentId) : null;

		const trimmedFolderName = input.name.trim();

		if (parentId) {
			const parentFolder = await sourceFilesCollection.findOne({
				_id: parentId,
				workspace_id: workspaceId,
				type: 'folder'
			});
			if (!parentFolder) return ResponseWrapper.badRequest('Parent folder not found or is not a folder.');
		}

		const existingFolder = await sourceFilesCollection.findOne({
			workspace_id: workspaceId,
			parentId: parentId,
			name: trimmedFolderName,
			type: 'folder',
		});

		if (existingFolder) return ResponseWrapper.conflict('A folder with the same name already exists in this location.');


		const newSourceFileFolder: SourceFile = {
			_id: new ObjectId(),
			workspace_id: workspaceId,
			name: trimmedFolderName,
			type: input.type,
			parentId: parentId,
		};

		await sourceFilesCollection.insertOne(newSourceFileFolder);

		await updateAuditLog({
			entity: 'SourceFile',
			entityId: newSourceFileFolder._id.toString(),
			action: AuditLogAction.CREATE,
			actionBy: auth.payload?.name?.toString()!,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.created({
			message: 'Source file folder created successfully.',
			folder: newSourceFileFolder
		});
	} catch (error) {
		console.error('Error in creating the source file folder:', error);
		return ResponseWrapper.internalServerError('An error occurred while creating the source file folder.');
	}
}