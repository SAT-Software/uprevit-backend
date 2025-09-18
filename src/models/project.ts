import { ObjectId } from 'mongodb';

export type Project = {
	_id?: ObjectId;
	workspace_id: ObjectId;
	department_id: ObjectId;
	project_name: string;
	project_description: string;
	manager?: string;
	admin_id: ObjectId;
	users: ObjectId[];
	isArchived: boolean;
};