import { ObjectId } from "mongodb";

export type UserBookmarks = {
  _id: ObjectId,
  user_id: ObjectId,
  workspace_id: ObjectId,
  sourceFile_folders: ObjectId[],
  product_folders: Array<{
    _id: ObjectId;
    folder_name: string;
    products: ObjectId[];
  }>;
}