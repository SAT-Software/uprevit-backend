import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { SourceFiles } from '../../models/sourceFiles';
import { UserBookmarks } from '../../models/userBookmarks';
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
        // Extract folderId from path parameters
        const folderId = event.pathParameters?.folderId;

        // Validate required folderId parameter
        if (!folderId) {
            return ResponseWrapper.badRequest('Missing required path parameter: folderId');
        }

        // Validate ObjectId format for folderId
        if (!ObjectId.isValid(folderId)) {
            return ResponseWrapper.badRequest('Invalid folderId format. Must be a valid MongoDB ObjectId.');
        }

        const db = await getDb();

        // Check if source files folder exists
        const sourceFilesFolder: SourceFiles | null = await db.collection<SourceFiles>('sourceFiles').findOne({
            _id: new ObjectId(folderId)
        });

        if (!sourceFilesFolder) {
            return ResponseWrapper.notFound('Source files folder not found');
        }

        // Delete the source files folder
        const deleteResult = await db.collection<SourceFiles>('sourceFiles').deleteOne({
            _id: new ObjectId(folderId)
        });

        if (deleteResult.deletedCount === 0) {
            return ResponseWrapper.internalServerError('Failed to delete source files folder');
        }

        // Remove folder reference from user bookmarks (if any)
        await db.collection<UserBookmarks>('userBookmarks').updateMany(
            { 
                bookmarked_sourceFile_folders: new ObjectId(folderId) 
            },
            { 
                $pull: { 
                    bookmarked_sourceFile_folders: new ObjectId(folderId) 
                } 
            }
        );

        // Create audit log entry
        const auditRecord: AuditLog = {
            entity: 'sourceFiles',
            entityId: folderId,
            action: AuditLogAction.DELETE,
            actionBy: 'system', 
            actionAt: new Date(),
            active: true,
        };

        await updateAuditLog(auditRecord);

        return ResponseWrapper.success({
            message: 'Source files folder deleted successfully',
            deleted_id: folderId
        });

    } catch (err) {
        console.error('Error in Lambda handler:', err);
        return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
    }
};