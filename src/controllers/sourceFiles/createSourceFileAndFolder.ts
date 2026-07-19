import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { requireTenantContext, tenantObjectIdFilter } from "../../utils/tenantContext";
import { validateAllObjectIds, validateEnum, validateMissingFields } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { SourceFile } from "../../models/sourceFiles";
import { ObjectId } from "mongodb";
import { recordAuditEvent } from "../../utils/auditLogV2";
import type { AuditLogV2Change } from "../../models/auditLogV2";
import { resolveWorkspaceProductName } from "../../utils/sourceFilesAudit";
import { assertUsageActionAllowed, checkUploadWouldExceedLimit } from "../../utils/billing/enforcement";
import { getBillingAccountByWorkspaceId, normalizeLimits } from "../../utils/billing/billingAccounts";
import { recordCommittedUploadBytes } from "../../utils/billing/uploadCommit";

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context, auth } = tenantResult;

		if (!event.body) return ResponseWrapper.badRequest('Request body is missing.');

		const input = JSON.parse(event.body);

		const missingFieldsResult = validateMissingFields({
			name: input.name,
			type: input.type,
		});
		if (missingFieldsResult) return missingFieldsResult;

		if (input.type === 'file' && !input.url && !input.key) {
			return ResponseWrapper.badRequest("At least one of 'url' or 'key' is required for source files.");
		}

		const isValidEnum = validateEnum(['file', 'folder'], input.type)
		if(isValidEnum) return isValidEnum

		const objectIdValidation = validateAllObjectIds({
			...(input.parentId && { 'parentId': input.parentId }),
			...(input.product_id && { 'product_id': input.product_id })
		});
		if (objectIdValidation) return objectIdValidation;

		const sizeBytes = input.type === 'file' && typeof input.sizeBytes === 'number' && input.sizeBytes > 0
			? Math.floor(input.sizeBytes)
			: undefined;

		if (input.type === 'file') {
			const uploadCheck = await assertUsageActionAllowed(context.workspaceId, 'upload');
			if (!uploadCheck.allowed) return ResponseWrapper.forbidden(uploadCheck.reason);

			const billingAccount = await getBillingAccountByWorkspaceId(context.workspaceId);
			if (billingAccount && normalizeLimits(billingAccount).enabled && !sizeBytes) {
				return ResponseWrapper.badRequest('sizeBytes is required for file uploads when usage limits are enabled');
			}

			if (sizeBytes) {
				const limitCheck = await checkUploadWouldExceedLimit(context.workspaceId, sizeBytes);
				if (!limitCheck.allowed) {
					return ResponseWrapper.forbidden(limitCheck.reason ?? 'Upload limit reached');
				}
			}
		}

		const db = await getDb();
		const sourceFilesCollection = db.collection<SourceFile>('sourceFiles');
		const workspaceId = context.workspaceId;
		const parentId = input.parentId ? ObjectId.createFromHexString(input.parentId) : null;
		const productId = typeof input.product_id === 'string' ? ObjectId.createFromHexString(input.product_id) : null;

		if (productId && input.type !== 'folder') {
			return ResponseWrapper.badRequest('product_id can only be set for folders.');
		}

		if (productId && parentId) {
			return ResponseWrapper.badRequest('product_id can only be set on top-level folders.');
		}

		let linkedProductName: string | null = null;
		if (productId) {
			linkedProductName = await resolveWorkspaceProductName(db, productId, workspaceId);
			if (!linkedProductName) return ResponseWrapper.notFound('Product not found.');
		}

		const trimmedName = input.name.trim();

		if (parentId) {
			const parentFolder = await sourceFilesCollection.findOne({
				_id: parentId,
				workspace_id: workspaceId,
				type: 'folder'
			});
			if (!parentFolder) return ResponseWrapper.badRequest('Parent folder not found or is not a folder.');
		}

		const existingFileOrFolder = await sourceFilesCollection.findOne({
			workspace_id: workspaceId,
			parentId: parentId,
			name: trimmedName,
		});

		if (existingFileOrFolder) return ResponseWrapper.conflict(`A ${existingFileOrFolder.type} with the same name already exists in this location.`);


		const newSourceFile: SourceFile = {
			_id: new ObjectId(),
			workspace_id: workspaceId,
			name: trimmedName,
			type: input.type,
			parentId: parentId,
			...(input.type === 'folder' && productId && { product_id: productId }),
			...(input.type === 'file' && {
				...(input.url && { url: input.url }),
				...(input.key && { key: input.key }),
				...(sizeBytes && { sizeBytes }),
			}),
		};

		await sourceFilesCollection.insertOne(newSourceFile);

		if (newSourceFile.type === 'file' && sizeBytes && newSourceFile.key) {
			await recordCommittedUploadBytes({
				workspaceId,
				uploadKey: newSourceFile.key,
				sizeBytes,
				metadata: { sourceFileId: newSourceFile._id.toString() },
			});
		}

		const isFolder = newSourceFile.type === 'folder';

		if (isFolder) {
			const changes: AuditLogV2Change[] = [{
				path: 'name',
				from: null,
				to: newSourceFile.name,
			}];

			if (linkedProductName) {
				changes.push({
					path: 'product',
					from: null,
					to: linkedProductName,
				});
			}

			await recordAuditEvent({
				workspaceId: workspaceId.toString(),
				scope: { type: 'source-files', id: workspaceId.toString() },
				entity: { type: 'source_folder', id: newSourceFile._id.toString() },
				action: 'create',
				eventKey: 'source_files.folder.created',
				visibility: 'all',
				where: {
					module: 'source-files',
					parentId: parentId?.toString() ?? undefined,
				},
				auth: auth.payload,
				changes,
				meta: {
					folderName: newSourceFile.name,
					...(linkedProductName && { productName: linkedProductName }),
				},
			});
		} else {
			await recordAuditEvent({
				workspaceId: workspaceId.toString(),
				scope: { type: 'source-files', id: workspaceId.toString() },
				entity: { type: 'source_file', id: newSourceFile._id.toString() },
				action: 'create',
				eventKey: 'source_files.file.uploaded',
				visibility: 'all',
				where: {
					module: 'source-files',
					parentId: parentId?.toString() ?? undefined,
				},
				auth: auth.payload,
				changes: [],
				meta: { fileName: newSourceFile.name },
			});
		}

		return ResponseWrapper.created({
			message: input.type === 'file'  ? 'Source file created successfully.' : 'Source folder created successfully.',
			folder: newSourceFile
		});
	} catch (error) {
		logError('Create source file/folder handler failed', error);
		return ResponseWrapper.internalServerError('Failed to create source file or folder');
	}
}
