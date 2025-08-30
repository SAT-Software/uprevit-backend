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
        // Extract _id from query parameters (this is the source file _id, not folder _id)
        const fileId = event.queryStringParameters?._id;

        // Validate required _id parameter
        if (!fileId) {
            return ResponseWrapper.badRequest('Missing required query parameter: _id');
        }

        // Validate ObjectId format for file _id
        if (!ObjectId.isValid(fileId)) {
            return ResponseWrapper.badRequest('Invalid _id format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Find the source files folder that contains the file with the given _id
        const sourceFilesFolder: SourceFiles | null = await db.collection<SourceFiles>('sourceFiles').findOne({
            'folder._id': new ObjectId(fileId)
        });

        if (!sourceFilesFolder) {
            return ResponseWrapper.notFound('Source file not found in any folder');
        }

        // Find the specific file to delete
        const fileToDelete = sourceFilesFolder.folder.find(
            file => file._id && file._id.toString() === fileId
        );

        if (!fileToDelete) {
            return ResponseWrapper.notFound('Source file not found');
        }

        // Remove the file from the folder array
        const updatedFiles = sourceFilesFolder.folder.filter(
            file => file._id && file._id.toString() !== fileId
        );

        // Update the source files folder by removing the file
        const updateResult = await db.collection<SourceFiles>('sourceFiles').findOneAndUpdate(
            {
                _id: sourceFilesFolder._id
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
            return ResponseWrapper.internalServerError('Failed to delete source file');
        }

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'sourceFiles',
            entityId: sourceFilesFolder._id!.toString(),
            action: AuditLogAction.DELETE,
            actionBy: 'system', // This should ideally come from user session/token
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        // Return response with deleted file information
        return ResponseWrapper.success({
            message: 'Source file deleted successfully',
            file_name: fileToDelete.file_name,
            action_by: auditRecord.actionBy,
            action_at: auditRecord.actionAt
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};