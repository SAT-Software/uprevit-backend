import { ObjectId } from 'mongodb';

export type UserType = 'admin' | 'user' | 'approver';

export const EDITOR_USER_TYPES: UserType[] = ['admin', 'user'];
export const APPROVER_USER_TYPES: UserType[] = ['admin', 'user', 'approver'];

export type User = {
	_id?: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
	designation?: string;
	unit?: string;
	phone?: string;
	userType?: UserType | null;
	isManager?: boolean;
	location?: string;
	cognitoSub: string;
	workspaceId: ObjectId | null;
	status: 'invited' | 'active' | 'inactive';
	removedAt?: Date;
	removedByUserId?: ObjectId;
};
