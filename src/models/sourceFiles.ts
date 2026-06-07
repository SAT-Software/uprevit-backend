import { ObjectId } from "mongodb"


export interface SourceFile {
    _id: ObjectId
    workspace_id: ObjectId
    name: string
    type: 'file' | 'folder'
    parentId: ObjectId | null
    product_id?: ObjectId | null
    url?: string
    key?: string
    sizeBytes?: number
}
