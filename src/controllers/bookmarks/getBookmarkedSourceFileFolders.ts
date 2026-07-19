import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { logError } from '../../utils/logger';
import { requireTenantContext } from '../../utils/tenantContext';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { SourceFile } from '../../models/sourceFiles';
import { UserBookmarks } from '../../models/bookmarks';
import { attachSourceFolderFileCounts } from '../../utils/sourceFolderFileCounts';

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;

		const db = await getDb();
		const userIdObj = context.userId;
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');

		const bookmarks = await db.collection<UserBookmarks>('bookmarks').findOne({
			user_id: userIdObj,
			workspace_id: context.workspaceId,
		});
		const bookmarkedFolderIds = bookmarks ? bookmarks.sourceFile_folders.map((id) => id.toString()) : [];

		if (bookmarkedFolderIds.length === 0) {
			return ResponseWrapper.success({
				message: 'No bookmarked source file folders found.',
				result: [],
			});
		}

		const allBookmarkedFolders = await sourceFilesCollection
			.find({
				_id: { $in: bookmarkedFolderIds.map((id) => new ObjectId(id)) },
				workspace_id: context.workspaceId,
			})
			.toArray();

		const bookmarkedFoldersWithFileCounts = await attachSourceFolderFileCounts(
			sourceFilesCollection,
			allBookmarkedFolders,
			context.workspaceId,
		);

		return ResponseWrapper.success({
			message: 'Source file folders fetched successfully.',
			result: bookmarkedFoldersWithFileCounts,
		});
	} catch (error) {
		logError('Get bookmarked source file folders handler failed', error);
		return ResponseWrapper.internalServerError('Failed to get bookmarked source file folders');
	}
};
