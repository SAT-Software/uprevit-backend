import { ObjectId } from 'mongodb';

export const PLATFORM_ADMINS_COLLECTION = 'platformAdmins';

export type PlatformAdminStatus = 'active' | 'disabled';
export type PlatformAdminRole = 'owner' | 'operator' | 'viewer';

export type PlatformAdmin = {
	_id?: ObjectId;
	cognitoSub: string;
	email: string;
	name?: string;
	status: PlatformAdminStatus;
	role: PlatformAdminRole;
	createdAt: Date;
	updatedAt: Date;
	lastSeenAt?: Date;
};
