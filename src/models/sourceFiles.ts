import { ObjectId } from "mongodb"


export interface SourceFile {
    _id: ObjectId
    workspace_id: ObjectId
    name: string
    type: 'file' | 'folder'
    parentId: ObjectId | null
    url?: string
}
