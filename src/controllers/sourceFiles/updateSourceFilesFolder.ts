import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds, validateMissingFields } from "../../utils/validationUtils";
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

		const missingFieldsResult = validateMissingFields({
			name: input.name,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const  validateFolderId = validateAllObjectIds({ folderId });
		if (validateFolderId) return validateFolderId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const folderObjectId = new ObjectId(folderId);
		const trimmedFolderName = input.name.trim();

		const updatedFolder = await sourceFilesCollection.findOneAndUpdate(
			{ _id: folderObjectId, type: 'folder' },
			{ $set: { name: trimmedFolderName } },
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