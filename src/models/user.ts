import { ObjectId } from 'mongodb';

export type User = {
	_id?: ObjectId;
	name: string;
	profileAvatar: string;
	designation: string;
	email: string;
	phone: string;
	confirmed: boolean;
	userType: string;
};
