import { ObjectId } from "mongodb";

export interface ProductBookmarkFolder {
  _id: ObjectId;
  folder_name: string;
  products: ObjectId[];
}

export type UserBookmarks = {
  _id: ObjectId,
  user_id: ObjectId,
  workspace_id: ObjectId,
  sourceFile_folders: ObjectId[],
  product_folders: Array<ProductBookmarkFolder>;
}