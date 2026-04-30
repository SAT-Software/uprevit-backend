import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { getDb } from "../../utils/db";
import { StandardSymbol } from "../../models/standardSymbols";
import { createStandardSymbolPresignedGetUrlMap } from "../../utils/s3-storage";

/**
 * Get all standard symbols
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event)
		if(!auth.isValid) {
			return auth.error
		}

		const db = await getDb();
		const standardSymbolsData = await db.collection<StandardSymbol>('standard_symbols')
			.find({ active: true })
			.sort({ sort_order: 1, ref_number: 1, title: 1 })
			.toArray();

		const signedUrlMap = await createStandardSymbolPresignedGetUrlMap(
			standardSymbolsData.map((symbol) => symbol.image_key),
		);

		const result = standardSymbolsData.map((symbol) => ({
			id: symbol._id?.toString(),
			title: symbol.title,
			standard: symbol.standard,
			standard_description: symbol.standard_description,
			ref_number: symbol.ref_number,
			image_key: symbol.image_key,
			image: signedUrlMap.get(symbol.image_key) || '',
			active: symbol.active,
			sort_order: symbol.sort_order,
		}));

		return ResponseWrapper.success({message: 'All Symbols fetched successfully', result})
	} catch (error) {
		return ResponseWrapper.internalServerError('Failed to get all the standard symbols data')
        
	}
}   
