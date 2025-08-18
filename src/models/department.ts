import { ObjectId } from 'mongodb';

export type Department = {
	_id?: ObjectId;
	workspace_id: ObjectId;
	department_name: string;
	department_description: string;
	image?: string;
	manager?: string;
	admin_id: ObjectId;
	users: ObjectId[];
}; 