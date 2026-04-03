import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { StatusCodes } from '../../utils/statusCodes';
import { logError } from '../../utils/logger';
import { authenticateRequest } from '../../utils/authUtils';
import { validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import { EXPORT_LIMITS } from '../../types/reports';
import { validateConditions, buildExportPipeline } from '../../utils/reports/queryBuilder';
import { generateReportsPDFExport } from '../../utils/reports/exportReportsPDF';

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		if (!event.body) return ResponseWrapper.badRequest('Request body is required');

		let input;
		try {
			input = JSON.parse(event.body!);
		} catch {
			return ResponseWrapper.badRequest('Invalid JSON in request body');
		}

		const missingFieldsResult = validateMissingFields({
			workspaceId: input.workspaceId,
		});
		if (missingFieldsResult) return missingFieldsResult;

		const objectIdValidation = validateObjectIds({ workspaceId: input.workspaceId });
		if (objectIdValidation) return objectIdValidation;

		if (input.conditionLogic && !['AND', 'OR'].includes(input.conditionLogic)) {
			return ResponseWrapper.badRequest('conditionLogic must be either "AND" or "OR"');
		}

		if (input.conditions && input.conditions.length > 0) {
			const conditionError = validateConditions(input.conditions);
			if (conditionError) return conditionError;
		}

		const workspaceId = ObjectId.createFromHexString(input.workspaceId);
		const pipeline = buildExportPipeline(input, workspaceId, EXPORT_LIMITS.PDF);

		const db = await getDb();
		const products = (await db.collection<Product>('products').aggregate(pipeline).toArray()) as any[];

		const pdfBuffer = await generateReportsPDFExport(products);
		if (!pdfBuffer) return ResponseWrapper.internalServerError('Failed to generate PDF file');

		const timestamp = new Date().toISOString().split('T')[0];

		return {
			statusCode: StatusCodes.SUCCESS,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': `attachment; filename="Products_Report_${timestamp}.pdf"`,
				'Access-Control-Allow-Origin': '*',
			},
			body: Buffer.from(pdfBuffer).toString('base64'),
			isBase64Encoded: true,
		};
	} catch (err) {
		logError('Reports PDF export handler failed', err);
		return ResponseWrapper.internalServerError('Failed to export reports PDF');
	}
};
