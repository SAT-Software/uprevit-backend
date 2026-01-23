import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { StatusCodes } from "../../utils/statusCodes";
import { logError } from '../../utils/logger';
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { Product } from "../../models/product";
import { ObjectId } from "mongodb";
import { generateProductExcelExport } from "../../utils/exportExcel";


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

		const excelBuffer = await generateProductExcelExport(productData);
		if (!excelBuffer) return ResponseWrapper.internalServerError("Failed to generate Excel file");


		return {
			statusCode: StatusCodes.SUCCESS,
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'Content-Disposition': `attachment; filename="Product_${productData.product_plan_number}_v${productData.version}.xlsx"`,
				'Access-Control-Allow-Origin': '*',
			},
			body: Buffer.from(excelBuffer).toString('base64'),
			isBase64Encoded: true
		};
	} catch (error) {
		logError('Product Excel export handler failed', error);
		return ResponseWrapper.internalServerError('Failed to export product Excel');
	}
}
