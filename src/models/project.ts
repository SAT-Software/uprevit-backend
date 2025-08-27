import { ObjectId } from 'mongodb';

export type Project = {
	_id?: ObjectId;
	workspace_id: ObjectId;
	department_id: ObjectId;
	project_name: string;
	project_number: string;
	project_description: string;
	project_manager?: string;
	admin_id: ObjectId;
	isArchived: boolean;
};