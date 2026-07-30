import { Collection, ObjectId } from 'mongodb';
import { SourceFile } from '../models/sourceFiles';

type FolderWithId = {
	_id: ObjectId;
};

/**
 * Attaches direct child file counts to source file folders via one aggregation.
 *
 * @param {Collection<SourceFile>} collection Source files collection.
 * @param {Array<{ _id: ObjectId }>} folders Folders to enrich.
 * @param {ObjectId} workspaceId Workspace scope for the count query.
 * @return {Promise<Array>} Folders with fileCount (default 0).
 */
export async function attachSourceFolderFileCounts<T extends FolderWithId>(
	collection: Collection<SourceFile>,
	folders: T[],
	workspaceId: ObjectId,
): Promise<Array<T & { fileCount: number }>> {
	if (folders.length === 0) return [];

	const folderIds = folders.map((folder) => folder._id);

	const countResults = await collection
		.aggregate<{ _id: ObjectId; fileCount: number }>([
			{
				$match: {
					workspace_id: workspaceId,
					type: 'file',
					parentId: { $in: folderIds },
				},
			},
			{
				$group: {
					_id: '$parentId',
					fileCount: { $sum: 1 },
				},
			},
		])
		.toArray();

	const countByFolderId = new Map<string, number>();
	for (const result of countResults) {
		countByFolderId.set(result._id.toString(), result.fileCount);
	}

	return folders.map((folder) => ({
		...folder,
		fileCount: countByFolderId.get(folder._id.toString()) ?? 0,
	}));
}
