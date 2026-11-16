import { ObjectId } from 'mongodb';
import { getDb } from '../db';

export const UPLOAD_GRANTS_COLLECTION = 'uploadGrants';

export type UploadGrant = {
	_id?: ObjectId;
	key: string;
	workspaceId: ObjectId;
	sizeBytes: number;
	contentType: string;
	expiresAt: Date;
	createdAt: Date;
};

let indexesReady: Promise<unknown> | undefined;

export const getUploadGrants = async () => {
	const collection = (await getDb()).collection<UploadGrant>(UPLOAD_GRANTS_COLLECTION);
	indexesReady ??= collection.createIndexes([
		{ key: { key: 1 }, unique: true },
		{ key: { workspaceId: 1 } },
		{ key: { expiresAt: 1 } },
	]).catch((error) => {
		indexesReady = undefined;
		throw error;
	});
	await indexesReady;
	return collection;
};

export const recordUploadGrant = async (grant: Omit<UploadGrant, '_id' | 'createdAt'>): Promise<void> => {
	await (await getUploadGrants()).insertOne({ ...grant, createdAt: new Date() });
};

export const clearUploadGrant = async (key: string): Promise<void> => {
	await (await getUploadGrants()).deleteOne({ key });
};

export const sumPendingUploadGrantBytes = async (
	workspaceId: ObjectId,
	excludeKeys: string[] = [],
): Promise<number> => {
	const [result] = await (await getUploadGrants()).aggregate<{ total: number }>([
		{ $match: { workspaceId, key: { $nin: excludeKeys } } },
		{ $group: { _id: null, total: { $sum: '$sizeBytes' } } },
	]).toArray();
	return result?.total ?? 0;
};
