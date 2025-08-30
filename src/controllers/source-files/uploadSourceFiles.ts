import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SourceFiles, SourceFileItem } from '../../models/sourceFiles';
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
        // Extract _id from query parameters
        const folderId = event.queryStringParameters?._id;

        // Validate required _id parameter
        if (!folderId) {
            return ResponseWrapper.badRequest('Missing required query parameter: _id');
        }

        // Validate ObjectId format for folder _id
        if (!ObjectId.isValid(folderId)) {
            return ResponseWrapper.badRequest('Invalid _id format. Must be a valid MongoDB ObjectId.');
        }

        if (!event.body) {
            return ResponseWrapper.badRequest('Request body is required');
        }

        type UploadSourceFilesInput = {
            files: Array<{
                file_name: string;
                url: string;
            }>;
        };

        const input: UploadSourceFilesInput = JSON.parse(event.body);

        // Validate required fields
        if (!input.files || !Array.isArray(input.files)) {
            return ResponseWrapper.badRequest('Missing required field: files must be an array');
        }

        if (input.files.length === 0) {
            return ResponseWrapper.badRequest('Files array cannot be empty');
        }

        // Validate each file object
        for (let i = 0; i < input.files.length; i++) {
            const file = input.files[i];
            
            if (!file.file_name || typeof file.file_name !== 'string') {
                return ResponseWrapper.badRequest(`Invalid file at index ${i}: file_name is required and must be a string`);
            }

            if (!file.url || typeof file.url !== 'string') {
                return ResponseWrapper.badRequest(`Invalid file at index ${i}: url is required and must be a string`);
            }

            // Basic URL validation
            try {
                new URL(file.url);
            } catch {
                return ResponseWrapper.badRequest(`Invalid file at index ${i}: url must be a valid URL`);
            }

            // Validate file_name (basic validation)
            if (file.file_name.trim().length === 0) {
                return ResponseWrapper.badRequest(`Invalid file at index ${i}: file_name cannot be empty`);
            }

            if (file.file_name.length > 255) {
                return ResponseWrapper.badRequest(`Invalid file at index ${i}: file_name cannot exceed 255 characters`);
            }
        }

        const db = await getDb();

        // Check if source files folder exists
        const sourceFilesFolder: SourceFiles | null = await db.collection<SourceFiles>('sourceFiles').findOne({
            _id: new ObjectId(folderId)
        });

        if (!sourceFilesFolder) {
            return ResponseWrapper.notFound('Source files folder not found');
        }

        // Process files to add ObjectIds
        const processedFiles: SourceFileItem[] = input.files.map(file => ({
            _id: new ObjectId(),
            file_name: file.file_name.trim(),
            url: file.url.trim()
        }));

        // Check for duplicate file names within the request
        const fileNames = processedFiles.map(f => f.file_name.toLowerCase());
        const uniqueFileNames = new Set(fileNames);
        if (fileNames.length !== uniqueFileNames.size) {
            return ResponseWrapper.badRequest('Duplicate file names are not allowed within the same request');
        }

        // Check for duplicate file names with existing files in the folder
        const existingFileNames = new Set(
            sourceFilesFolder.folder.map(f => f.file_name.toLowerCase())
        );

        for (const fileName of fileNames) {
            if (existingFileNames.has(fileName)) {
                return ResponseWrapper.badRequest(`File name '${fileName}' already exists in this folder`);
            }
        }

        // Add new files to the existing folder array
        const updatedFiles = [...sourceFilesFolder.folder, ...processedFiles];

        // Update the source files folder with new files
        const updateResult = await db.collection<SourceFiles>('sourceFiles').findOneAndUpdate(
            {
                _id: new ObjectId(folderId)
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

        if (!updateResult) {
            return ResponseWrapper.internalServerError('Failed to upload source files');
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'sourceFiles',
            entityId: folderId,
            action: AuditLogAction.UPDATE,
            actionBy: 'system', // This should ideally come from user session/token
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Prepare response data matching the required format
        const responseData = {
            _id: updateResult._id,
            folder_name: updateResult.folder_name,
            product_id: updateResult.product_id,
            workspace_id: updateResult.workspace_id,
            folder: updateResult.folder,
            action_by: auditRecord.actionBy,
            action_at: auditRecord.actionAt
        };

        return ResponseWrapper.success({
            message: 'Source files uploaded successfully',
            sourceFilesFolder: responseData
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        
        // Handle JSON parsing errors
        if (err instanceof SyntaxError) {
            return ResponseWrapper.badRequest('Invalid JSON format in request body');
        }

        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};