import { ObjectId } from 'mongodb';

export type BookmarkProductFolder = {
	_id: ObjectId;
	folder_name: string;
	products: ObjectId[];
};

export type UserBookmarks = {
	_id?: ObjectId;
	user_id: ObjectId;
	workspace_id: ObjectId;
	bookmarked_sourceFile_folders: ObjectId[];
	bookmarked_product_folders: BookmarkProductFolder[];
};