import { ClientSession, Db, ObjectId } from 'mongodb';
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

/** Creates the notification indexes once per container; call before a transaction that saves notifications. */
export const ensureNotificationIndexes = async () => {
	if (hasEnsuredIndexes) return;
	const db = await getDb();
	const collection = db.collection<Notification>(NOTIFICATIONS_COLLECTION);
	await Promise.all([
		collection.createIndex({ userId: 1, readAt: 1, createdAt: -1 }),
		collection.createIndex({ userId: 1, createdAt: -1 }),
	]);
	hasEnsuredIndexes = true;
};

type NotificationRecipient = Pick<User, '_id' | 'email'>;

/**
 * Saves an in-app notification for each active recipient. Throws on failure, so it can join a transaction.
 * @param {Db} db Database handle
 * @param {NotifyInput} input Notification content and recipients
 * @param {ClientSession} session Optional transaction session
 * @return {Promise<NotificationRecipient[]>} The recipients that were notified, for emailing
 */
export const saveNotifications = async (
	db: Db,
	{ workspaceId, recipients, type, title, body, link, meta }: NotifyInput,
	session?: ClientSession,
): Promise<NotificationRecipient[]> => {
	const ids = [...new Map(recipients.filter((id): id is ObjectId => !!id).map((id) => [id.toString(), id])).values()];
	if (ids.length === 0) return [];

	const users = await db.collection<User>('users')
		.find({ _id: { $in: ids }, workspaceId, status: 'active' }, { projection: { email: 1 }, session })
		.toArray();
	if (users.length === 0) return [];

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
	})), { session });
	return users;
};

/**
 * Emails a saved notification to its recipients. Never throws; failures are logged.
 * @param {NotificationRecipient[]} users Recipients from `saveNotifications`
 * @param {NotifyInput} input Notification content
 * @return {Promise<void>} Resolves once emails are attempted
 */
export const emailNotifications = (users: NotificationRecipient[], { type, title, body, link }: NotifyInput) =>
	Promise.all(users.map((user) => sendEmail({ to: user.email, subject: title, title, body, link })
		.catch((err) => logError('Notification email failed', err, { type, userId: user._id?.toString() }))));

/**
 * Saves an in-app notification for each active recipient and emails them.
 * Never throws: a failed notification or email must not fail the action that triggered it.
 * @param {NotifyInput} input Notification content and recipients
 * @return {Promise<void>} Resolves once notifications are saved and emails attempted
 */
export const notify = async (input: NotifyInput): Promise<void> => {
	try {
		await ensureNotificationIndexes();
		const users = await saveNotifications(await getDb(), input);
		if (input.email !== false) await emailNotifications(users, input);
	} catch (err) {
		logError('Notify failed', err, { type: input.type, workspaceId: input.workspaceId.toString() });
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
