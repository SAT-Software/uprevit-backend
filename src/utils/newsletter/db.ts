import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export type SubscriberStatus = 'pending' | 'subscribed' | 'unsubscribed' | 'bounced' | 'complained';

export interface NewsletterSubscriber {
	email: string;
	status: SubscriberStatus;
	createdAt: string;
	updatedAt: string;
	confirmedAt?: string;
	unsubscribedAt?: string;
	suppressedAt?: string;
	suppressionReason?: string;
	confirmTokenHash?: string;
	confirmTokenExpiresAt?: string;
	source?: string;
}

export interface NewsletterBroadcast {
	slug: string;
	title: string;
	subject: string;
	status: 'enqueueing' | 'queued' | 'sent';
	queuedAt: string;
	recipientCount: number;
	sentCount: number;
	failedCount: number;
	leaseOwner?: string;
	leaseExpiresAt?: string;
}

export interface NewsletterBroadcastDelivery {
	slug: string;
	postSlug: string;
	email: string;
	status: 'queued' | 'sent';
	updatedAt: string;
	sentAt?: string;
}

const dynamoClient = new DynamoDBClient({
	region: process.env.AWS_REGION || 'us-east-1',
	maxAttempts: 3,
});

const docClient = DynamoDBDocumentClient.from(dynamoClient, {
	marshallOptions: { removeUndefinedValues: true },
});

const requireTable = (envName: string): string => {
	const table = process.env[envName]?.trim();
	if (!table) {
		throw new Error(`Missing required environment variable: ${envName}`);
	}
	return table;
};

export const getSubscribersTableName = () => requireTable('NEWSLETTER_SUBSCRIBERS_TABLE');
export const getBroadcastsTableName = () => requireTable('NEWSLETTER_BROADCASTS_TABLE');
export const getRateLimitsTableName = () => requireTable('NEWSLETTER_RATE_LIMITS_TABLE');

export const broadcastDeliveryKey = (postSlug: string, email: string): string =>
	`delivery#${postSlug}#${email.trim().toLowerCase()}`;

export const getSubscriber = async (email: string): Promise<NewsletterSubscriber | null> => {
	const result = await docClient.send(
		new GetCommand({
			TableName: getSubscribersTableName(),
			Key: { email: email.trim().toLowerCase() },
		}),
	);
	return (result.Item as NewsletterSubscriber | undefined) ?? null;
};

export const upsertPendingSubscriber = async (params: {
	email: string;
	confirmTokenHash: string;
	confirmTokenExpiresAt: string;
	nowIso: string;
	source?: string;
}): Promise<boolean> => {
	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getSubscribersTableName(),
				Key: { email: params.email.trim().toLowerCase() },
				ConditionExpression:
					'attribute_not_exists(#status) OR (#status <> :subscribed AND #status <> :bounced AND #status <> :complained)',
				UpdateExpression:
					'SET #status = :status, createdAt = if_not_exists(createdAt, :now), updatedAt = :now, confirmTokenHash = :hash, confirmTokenExpiresAt = :exp, #source = :source REMOVE unsubscribedAt',
				ExpressionAttributeNames: {
					'#status': 'status',
					'#source': 'source',
				},
				ExpressionAttributeValues: {
					':status': 'pending',
					':subscribed': 'subscribed',
					':bounced': 'bounced',
					':complained': 'complained',
					':now': params.nowIso,
					':hash': params.confirmTokenHash,
					':exp': params.confirmTokenExpiresAt,
					':source': params.source ?? 'blog',
				},
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return false;
		throw error;
	}
};

export const confirmSubscriber = async (email: string, expectedTokenHash: string, nowIso: string): Promise<boolean> => {
	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getSubscribersTableName(),
				Key: { email: email.trim().toLowerCase() },
				ConditionExpression: '#status = :pending AND confirmTokenHash = :expectedHash AND confirmTokenExpiresAt > :now',
				UpdateExpression:
					'SET #status = :status, confirmedAt = :now, updatedAt = :now REMOVE confirmTokenHash, confirmTokenExpiresAt, unsubscribedAt',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: {
					':pending': 'pending',
					':expectedHash': expectedTokenHash,
					':status': 'subscribed',
					':now': nowIso,
				},
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return false;
		throw error;
	}
};

export const unsubscribeSubscriber = async (email: string, nowIso: string): Promise<void> => {
	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getSubscribersTableName(),
				Key: { email: email.trim().toLowerCase() },
				ConditionExpression: 'attribute_not_exists(#status) OR (#status <> :bounced AND #status <> :complained)',
				UpdateExpression:
					'SET #status = :status, createdAt = if_not_exists(createdAt, :now), updatedAt = :now, unsubscribedAt = :now REMOVE confirmTokenHash, confirmTokenExpiresAt',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: {
					':status': 'unsubscribed',
					':bounced': 'bounced',
					':complained': 'complained',
					':now': nowIso,
				},
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return;
		throw error;
	}
};

export const suppressSubscriber = async (params: {
	email: string;
	status: 'bounced' | 'complained';
	reason: string;
	nowIso: string;
}): Promise<void> => {
	await docClient.send(
		new UpdateCommand({
			TableName: getSubscribersTableName(),
			Key: { email: params.email.trim().toLowerCase() },
			UpdateExpression:
				'SET #status = :status, createdAt = if_not_exists(createdAt, :now), updatedAt = :now, suppressedAt = :now, suppressionReason = :reason REMOVE confirmTokenHash, confirmTokenExpiresAt',
			ExpressionAttributeNames: { '#status': 'status' },
			ExpressionAttributeValues: {
				':status': params.status,
				':now': params.nowIso,
				':reason': params.reason,
			},
		}),
	);
};

export const listActiveSubscribers = async (): Promise<NewsletterSubscriber[]> => {
	const subscribers: NewsletterSubscriber[] = [];
	let exclusiveStartKey: Record<string, unknown> | undefined;

	do {
		const result = await docClient.send(
			new QueryCommand({
				TableName: getSubscribersTableName(),
				IndexName: 'StatusIndex',
				KeyConditionExpression: '#status = :subscribed',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: { ':subscribed': 'subscribed' },
				ExclusiveStartKey: exclusiveStartKey,
			}),
		);
		if (result.Items) {
			subscribers.push(...(result.Items as NewsletterSubscriber[]));
		}
		exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
	} while (exclusiveStartKey);

	return subscribers;
};

export const bumpRateLimit = async (pk: string, delta: 1 | -1, expiresAtSec: number): Promise<number> => {
	const result = await docClient.send(
		new UpdateCommand({
			TableName: getRateLimitsTableName(),
			Key: { pk },
			UpdateExpression: 'ADD #count :delta SET expiresAt = if_not_exists(expiresAt, :exp)',
			ExpressionAttributeNames: { '#count': 'count' },
			ExpressionAttributeValues: {
				':delta': delta,
				':exp': expiresAtSec,
			},
			ReturnValues: 'ALL_NEW',
		}),
	);
	return Number(result.Attributes?.count ?? 0);
};

const BROADCAST_LEASE_MS = 5 * 60 * 1000;

export const beginBroadcast = async (params: {
	slug: string;
	title: string;
	subject: string;
	recipientCount: number;
	leaseOwner: string;
	nowMs?: number;
}): Promise<'started' | 'resumed' | 'in_progress' | 'already_queued'> => {
	const nowMs = params.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const leaseExpiresAt = new Date(nowMs + BROADCAST_LEASE_MS).toISOString();

	try {
		await docClient.send(
			new PutCommand({
				TableName: getBroadcastsTableName(),
				Item: {
					slug: params.slug,
					title: params.title,
					subject: params.subject,
					status: 'enqueueing',
					queuedAt: nowIso,
					recipientCount: params.recipientCount,
					sentCount: 0,
					failedCount: 0,
					leaseOwner: params.leaseOwner,
					leaseExpiresAt,
				} satisfies NewsletterBroadcast,
				ConditionExpression: 'attribute_not_exists(slug)',
			}),
		);
		return 'started';
	} catch (error) {
		if (!(error instanceof ConditionalCheckFailedException)) throw error;
	}

	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getBroadcastsTableName(),
				Key: { slug: params.slug },
				ConditionExpression: '#status = :enqueueing AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)',
				UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :exp, updatedAt = :now',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: {
					':enqueueing': 'enqueueing',
					':owner': params.leaseOwner,
					':exp': leaseExpiresAt,
					':now': nowIso,
				},
			}),
		);
		return 'resumed';
	} catch (error) {
		if (!(error instanceof ConditionalCheckFailedException)) throw error;
	}

	const existing = await docClient.send(
		new GetCommand({
			TableName: getBroadcastsTableName(),
			Key: { slug: params.slug },
		}),
	);
	const broadcast = existing.Item as NewsletterBroadcast | undefined;
	return broadcast?.status === 'enqueueing' ? 'in_progress' : 'already_queued';
};

export const releaseBroadcastLease = async (slug: string, leaseOwner: string, nowIso: string): Promise<void> => {
	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getBroadcastsTableName(),
				Key: { slug },
				ConditionExpression: '#status = :enqueueing AND leaseOwner = :owner',
				UpdateExpression: 'SET updatedAt = :now REMOVE leaseOwner, leaseExpiresAt',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: {
					':enqueueing': 'enqueueing',
					':owner': leaseOwner,
					':now': nowIso,
				},
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return;
		throw error;
	}
};

export const markBroadcastQueued = async (slug: string, leaseOwner: string, nowIso: string): Promise<void> => {
	await docClient.send(
		new UpdateCommand({
			TableName: getBroadcastsTableName(),
			Key: { slug },
			ConditionExpression: '#status = :enqueueing AND leaseOwner = :owner',
			UpdateExpression: 'SET #status = :queued, updatedAt = :now REMOVE leaseOwner, leaseExpiresAt',
			ExpressionAttributeNames: { '#status': 'status' },
			ExpressionAttributeValues: {
				':enqueueing': 'enqueueing',
				':owner': leaseOwner,
				':queued': 'queued',
				':now': nowIso,
			},
		}),
	);
};

export const getBroadcastDelivery = async (postSlug: string, email: string): Promise<NewsletterBroadcastDelivery | null> => {
	const result = await docClient.send(
		new GetCommand({
			TableName: getBroadcastsTableName(),
			Key: { slug: broadcastDeliveryKey(postSlug, email) },
		}),
	);
	return (result.Item as NewsletterBroadcastDelivery | undefined) ?? null;
};

export const markBroadcastDeliveryQueued = async (postSlug: string, email: string, nowIso: string): Promise<void> => {
	const normalizedEmail = email.trim().toLowerCase();
	try {
		await docClient.send(
			new PutCommand({
				TableName: getBroadcastsTableName(),
				Item: {
					slug: broadcastDeliveryKey(postSlug, normalizedEmail),
					postSlug,
					email: normalizedEmail,
					status: 'queued',
					updatedAt: nowIso,
				} satisfies NewsletterBroadcastDelivery,
				ConditionExpression: 'attribute_not_exists(slug)',
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return;
		throw error;
	}
};

export const markBroadcastDeliverySent = async (postSlug: string, email: string, nowIso: string): Promise<boolean> => {
	const normalizedEmail = email.trim().toLowerCase();
	try {
		await docClient.send(
			new UpdateCommand({
				TableName: getBroadcastsTableName(),
				Key: { slug: broadcastDeliveryKey(postSlug, normalizedEmail) },
				ConditionExpression: 'attribute_not_exists(#status) OR #status <> :sent',
				UpdateExpression: 'SET postSlug = :postSlug, email = :email, #status = :sent, sentAt = :now, updatedAt = :now',
				ExpressionAttributeNames: { '#status': 'status' },
				ExpressionAttributeValues: {
					':postSlug': postSlug,
					':email': normalizedEmail,
					':sent': 'sent',
					':now': nowIso,
				},
			}),
		);
		return true;
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) return false;
		throw error;
	}
};

export const incrementBroadcastCounter = async (slug: string, field: 'sentCount' | 'failedCount'): Promise<void> => {
	await docClient.send(
		new UpdateCommand({
			TableName: getBroadcastsTableName(),
			Key: { slug },
			UpdateExpression: 'ADD #field :one SET updatedAt = :now',
			ExpressionAttributeNames: { '#field': field },
			ExpressionAttributeValues: {
				':one': 1,
				':now': new Date().toISOString(),
			},
		}),
	);
};
