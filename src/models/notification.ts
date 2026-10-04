import { ObjectId } from 'mongodb';

export const NOTIFICATIONS_COLLECTION = 'notifications';

export type NotificationType =
	| 'product.owner_assigned'
	| 'product.contributor_added'
	| 'product.returned_to_draft'
	| 'product.ownership_transferred'
	| 'workflow.approval_requested'
	| 'workflow.product_in_review'
	| 'workflow.approved'
	| 'workflow.ready_to_complete'
	| 'workflow.completed'
	| 'workflow.rejected'
	| 'workflow.cancelled';

export type Notification = {
	_id?: ObjectId;
	workspaceId: ObjectId;
	userId: ObjectId;
	type: NotificationType;
	title: string;
	body?: string;
	link?: string;
	meta?: Record<string, unknown>;
	readAt: Date | null;
	createdAt: Date;
};
