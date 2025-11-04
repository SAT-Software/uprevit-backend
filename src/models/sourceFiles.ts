import { ObjectId } from "mongodb"

export interface SourceFileFolder {
    _id: ObjectId
    file_name: string,
    url: string  
}

// For the adjacency list pattern - represents either a file or folder
export interface SourceFileNode {
    _id: ObjectId
    name: string
    type: 'file' | 'folder'
    parentId: ObjectId | null // null for root folders
    url?: string // Only for files
    workspace_id: ObjectId
}

// Legacy interface for backward compatibility during migration
export type SourceFiles = {
  _id: ObjectId, 
  folder_name: String,
  workspace_id: ObjectId,
  folder: Array<SourceFileFolder>
}