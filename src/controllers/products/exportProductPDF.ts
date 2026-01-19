import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { Product } from "../../models/product";
import { ObjectId } from "mongodb";
import { generateProductPDFExport } from "../../utils/exportPDF";


/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */


export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);

		if(!auth.isValid) return auth.error;

		const productId = event.pathParameters?.productId;
		if(!productId) return ResponseWrapper.badRequest("Product id - 'productId' is required in path parameters");

		const db = await getDb();

		const productData = await db.collection<Product>('products').findOne({ _id: new ObjectId(productId) });
		if(!productData) return ResponseWrapper.notFound("Product not found");

		const pdfBuffer = await generateProductPDFExport(productData);
		if (!pdfBuffer) return ResponseWrapper.internalServerError("Failed to generate PDF file");


		return {
			statusCode: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': `attachment; filename="Product_${productData.product_plan_number}_v${productData.version}.pdf"`,
				'Access-Control-Allow-Origin': '*',
			},
			body: Buffer.from(pdfBuffer).toString('base64'),
			isBase64Encoded: true
		};
	} catch (error) {
		logError('Product PDF export handler failed', err);
		return ResponseWrapper.internalServerError('Failed to export product PDF');
	}
}
