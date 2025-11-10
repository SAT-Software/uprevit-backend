import { ObjectId } from 'mongodb';

export type User = {
	_id?: ObjectId;
	name: string;
	email: string;
	profileAvatar?: string;
	designation?: string;
	phone?: string;
	userType?: 'user' | 'admin';
	location?: string;
	cognitoSub: string;
	workspaceId: ObjectId | null;
	status: 'invited' | 'active'
};
