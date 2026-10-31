import { ClientSession, Db, ObjectId } from 'mongodb';
import { UserBookmarks } from '../models/bookmarks';

/**
 * Points every product bookmark at a product's new version, so bookmarks always follow the latest version.
 * @param {Db} db Database handle
 * @param {ObjectId} fromId Previous version
 * @param {ObjectId} toId New version
 * @param {ClientSession} session Optional session to join a transaction
 * @return {Promise<number>} Number of bookmark documents changed
 */
export const moveBookmarksToVersion = async (db: Db, fromId: ObjectId, toId: ObjectId, session?: ClientSession) => {
	const result = await db.collection<UserBookmarks>('bookmarks').updateMany(
		{ 'product_folders.products': fromId },
		{ $set: { 'product_folders.$[].products.$[product]': toId } },
		{ arrayFilters: [{ product: fromId }], session },
	);
	return result.modifiedCount;
};
