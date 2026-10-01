import { ObjectId } from 'mongodb';
import { NOTIFICATIONS_COLLECTION, type Notification, type NotificationType } from '../models/notification';
import type { User } from '../models/user';
import { getDb } from './db';
import { sendEmail } from './email';
import { logError } from './logger';

export type NotifyInput = {
	workspaceId: ObjectId;
	recipients: Array<ObjectId | undefined | null>;
	type: NotificationType;
	title: string;
	body?: string;
	link?: string;
	meta?: Record<string, unknown>;
	email?: boolean;
};

let hasEnsuredIndexes = false;

const ensureNotificationIndexes = async () => {
	if (hasEnsuredIndexes) return;
	const db = await getDb();
	await db.collection<Notification>(NOTIFICATIONS_COLLECTION).createIndex({ userId: 1, readAt: 1, createdAt: -1 });
	hasEnsuredIndexes = true;
};

/**
 * Saves an in-app notification for each active recipient and emails them.
 * Never throws: a failed notification or email must not fail the action that triggered it.
 * @param {NotifyInput} input Notification content and recipients
 * @return {Promise<void>} Resolves once notifications are saved and emails attempted
 */
export const notify = async ({ workspaceId, recipients, type, title, body, link, meta, email = true }: NotifyInput): Promise<void> => {
	try {
		const ids = [...new Map(recipients.filter((id): id is ObjectId => !!id).map((id) => [id.toString(), id])).values()];
		if (ids.length === 0) return;

		const db = await getDb();
		const users = await db.collection<User>('users')
			.find({ _id: { $in: ids }, workspaceId, status: 'active' }, { projection: { email: 1 } })
			.toArray();
		if (users.length === 0) return;

		await ensureNotificationIndexes();
		const createdAt = new Date();
		await db.collection<Notification>(NOTIFICATIONS_COLLECTION).insertMany(users.map((user) => ({
			workspaceId,
			userId: user._id!,
			type,
			title,
			...(body ? { body } : {}),
			...(link ? { link } : {}),
			...(meta ? { meta } : {}),
			readAt: null,
			createdAt,
		})));

		if (!email) return;
		await Promise.all(users.map((user) => sendEmail({ to: user.email, subject: title, title, body, link })
			.catch((err) => logError('Notification email failed', err, { type, userId: user._id?.toString() }))));
	} catch (err) {
		logError('Notify failed', err, { type, workspaceId: workspaceId.toString() });
	}
};

/**
 * Looks up a member's display name for notification copy.
 * @param {ObjectId} userId Member id
 * @return {Promise<string>} The member's name, or "Someone" when unknown
 */
export const getMemberName = async (userId: ObjectId): Promise<string> => {
	try {
		const db = await getDb();
		const user = await db.collection<User>('users').findOne({ _id: userId }, { projection: { name: 1 } });
		return user?.name || 'Someone';
	} catch (err) {
		logError('Notification member name lookup failed', err, { userId: userId.toString() });
		return 'Someone';
	}
};
