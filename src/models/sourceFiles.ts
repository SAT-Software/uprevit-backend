import { ObjectId } from 'mongodb';

export type SourceFileItem = {
	_id?: ObjectId;
	file_name: string;
	url: string;
};

export type SourceFiles = {
	_id?: ObjectId;
	folder_name: string;
	product_id: ObjectId;
	workspace_id: ObjectId;
	folder: SourceFileItem[];
};