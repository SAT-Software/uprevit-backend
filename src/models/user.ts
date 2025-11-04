import { ObjectId } from 'mongodb';

export type User = {
	_id?: ObjectId;
	name: string;
	email: string;
	profileAvatar: string;
	designation: string;
	organization: string;
	phone?: string;
	confirmed?: string;
	userType?: string;
	location?: string;
};
