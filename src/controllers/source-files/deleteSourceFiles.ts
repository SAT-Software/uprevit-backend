import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SourceFiles } from '../../models/sourceFiles';
import { AuditLog, AuditLogAction } from '../../models/auditLog';
import { updateAuditLog } from '../../utils/auditLog';
import { ObjectId } from 'mongodb';
import { ResponseWrapper } from '../../utils/responseWrapper';

/**
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        type DeleteSourceFilesInput = {
            fileIds: string[];
        };

        const input: DeleteSourceFilesInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.fileIds || !Array.isArray(input.fileIds)) {
            return ResponseWrapper.badRequest('Missing required field: fileIds must be an array');
        }

        if (input.fileIds.length === 0) {
            return ResponseWrapper.badRequest('fileIds array cannot be empty');
        }

        // Validate each fileId
        for (let i = 0; i < input.fileIds.length; i++) {
            const fileId = input.fileIds[i];
            if (!fileId || typeof fileId !== 'string') {
                return ResponseWrapper.badRequest(`Invalid fileId at index ${i}: must be a non-empty string`);
            }
            if (!ObjectId.isValid(fileId)) {
                return ResponseWrapper.badRequest(`Invalid fileId at index ${i}: must be a valid MongoDB ObjectId`);
            }
        }

        const db = await getDb();

        const fileObjectIds = input.fileIds.map(id => new ObjectId(id));

        const sourceFilesFolders: SourceFiles[] = await db.collection<SourceFiles>('sourceFiles').find({
            'folder._id': { $in: fileObjectIds }
        }).toArray();

        if (sourceFilesFolders.length === 0) {
            return ResponseWrapper.notFound('None of the specified source files found in any folder');
        }

        const deletedFiles: Array<{ file_name: string; folder_id: string }> = [];
        const notFoundFiles: string[] = [];

        const foundFileIds = new Set<string>();
        for (const folder of sourceFilesFolders) {
            for (const file of folder.folder) {
                if (file._id && input.fileIds.includes(file._id.toString())) {
                    foundFileIds.add(file._id.toString());
                }
            }
        }

        // Identify not found files
        for (const fileId of input.fileIds) {
            if (!foundFileIds.has(fileId)) {
                notFoundFiles.push(fileId);
            }
        }

        // Update each folder by removing the specified files
        for (const folder of sourceFilesFolders) {
            const filesToDelete = folder.folder.filter(
                file => file._id && input.fileIds.includes(file._id.toString())
            );

            const updatedFiles = folder.folder.filter(
                file => !file._id || !input.fileIds.includes(file._id.toString())
            );

            // Update the folder
            const updateResult = await db.collection<SourceFiles>('sourceFiles').findOneAndUpdate(
                {
                    _id: folder._id
                },
                {
                    $set: {
                        folder: updatedFiles
                    }
                },
                {
                    returnDocument: 'after'
                }
            );

            if (updateResult) {
                // Add deleted files to tracking array
                for (const file of filesToDelete) {
                    deletedFiles.push({
                        file_name: file.file_name,
                        folder_id: folder._id!.toString()
                    });
                }

                // Create audit log entry for this folder
                const auditRecord: AuditLog = {
                    entity: 'sourceFiles',
                    entityId: folder._id!.toString(),
                    action: AuditLogAction.DELETE,
                    actionBy: 'system', 
                    actionAt: new Date(),
                    active: true,
                };

                await updateAuditLog(auditRecord);
            }
        }

        // Prepare response
        const response: any = {
            message: `${deletedFiles.length} source file(s) deleted successfully`,
            deleted_files: deletedFiles,
            action_by: 'system',
            action_at: new Date()
        };

        if (notFoundFiles.length > 0) {
            response.not_found_files = notFoundFiles;
            response.message += `. ${notFoundFiles.length} file(s) were not found.`;
        }

        return ResponseWrapper.success(response);

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};