import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { Collection, ObjectId } from "mongodb";
import { SourceFile } from "../../models/sourceFiles";
import { recordAuditEvent } from "../../utils/auditLogV2";
import { deleteObjectByKey } from "../../utils/s3-storage";

/**
 * Recursively finds all descendant node IDs for a given parent folder.
 * @param {Collection<SourceFile>} collection The MongoDB collection to search.
 * @param {ObjectId} parentId The ID of the parent folder.
 * @return {Promise<ObjectId[]>} A promise that resolves to an array of descendant IDs.
 */
async function findDescendantIds(collection: Collection<SourceFile>, parentId: ObjectId): Promise<ObjectId[]> {
	let idsToDelete = [parentId];
	const children = await collection.find({ parentId: parentId }).toArray();
	for (const child of children) {
		if (child.type === 'folder') {
			const descendantIds = await findDescendantIds(collection, child._id);
			idsToDelete = idsToDelete.concat(descendantIds);
		} else {
			idsToDelete.push(child._id);
		}
	}
	return idsToDelete;
}

/**
 * @param {APIGatewayProxyEvent} event 
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if(!auth.isValid) return auth.error;

		const id = event.pathParameters?.id;
		if (!id) return ResponseWrapper.badRequest('Missing required path parameter: id');

		const validateId = validateAllObjectIds({ id });
		if (validateId) return validateId;

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const fileObjectId = new ObjectId(id);

		const fileOrFolder = await sourceFilesCollection.findOne({ _id: fileObjectId });
		if (!fileOrFolder) {
			return ResponseWrapper.notFound('File or folder not found.');
		}

		let idsToDelete: ObjectId[];

		if (fileOrFolder.type === 'folder') {
			idsToDelete = await findDescendantIds(sourceFilesCollection, fileObjectId);
		} else {
			idsToDelete = [fileObjectId];
		}

		const filesToDelete = await sourceFilesCollection
			.find({ _id: { $in: idsToDelete }, type: 'file' })
			.toArray();
		const keysToDelete = filesToDelete
			.map((item) => (typeof item.key === 'string' ? item.key.trim() : ''))
			.filter((key) => key.length > 0);

		for (const key of [...new Set(keysToDelete)]) {
			try {
				await deleteObjectByKey(key);
			} catch (error) {
				logError('Failed to delete source file object from S3', error);
			}
		}

		await sourceFilesCollection.deleteMany({ _id: { $in: idsToDelete } });

		await recordAuditEvent({
			workspaceId: fileOrFolder.workspace_id.toString(),
			scope: { type: 'source-files', id: fileOrFolder.workspace_id.toString() },
			entity: { type: fileOrFolder.type === 'folder' ? 'source_folder' : 'source_file', id },
			action: 'delete',
			eventKey: fileOrFolder.type === 'folder' ? 'source_files.folder.deleted' : 'source_files.file.deleted',
			visibility: 'all',
			where: {
				module: 'source-files',
				parentId: fileOrFolder.parentId?.toString() ?? undefined,
			},
			auth: auth.payload,
			before: {
				name: fileOrFolder.name,
				type: fileOrFolder.type,
				url: fileOrFolder.url,
				product_id: fileOrFolder.product_id?.toString() ?? null,
			},
			changedPaths: ['name', 'type', 'url', 'product_id'],
			meta: fileOrFolder.type === 'folder'
				? { folderName: fileOrFolder.name }
				: { fileName: fileOrFolder.name },
		});

		return ResponseWrapper.success({
			message: 'Source file or folder and its contents deleted successfully.',
		})
        
	} catch (error) {
		logError('Delete source file/folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to delete source file or folder');
	}
}
