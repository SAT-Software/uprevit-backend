import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { authenticateRequest } from "../../utils/authUtils";
import { validateAllObjectIds } from "../../utils/validationUtils";
import { getDb } from "../../utils/db";
import { UserBookmarks } from "../../models/bookmarks";
import { ObjectId } from "mongodb";

/**
 * @param {APIGatewayProxyEvent} event
 * @returns {Promise<APIGatewayProxyResult>}
 */

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return auth.error;

		const folderIdParam = event.pathParameters?.folderId;
		const userIdParam = event.queryStringParameters?.userId;

		if (!folderIdParam) return ResponseWrapper.badRequest("Folder ID is missing from path parameters.");
		if (!userIdParam) return ResponseWrapper.badRequest("User ID is missing from query string parameters.");

		const objectIdValidation = validateAllObjectIds({
			folderId: folderIdParam,
			userId: userIdParam,
		});
		if (objectIdValidation) return objectIdValidation;

		const folderId = ObjectId.createFromHexString(folderIdParam);
		const userId = ObjectId.createFromHexString(userIdParam);

		const db = await getDb();

		const pipeline = [
			{ $match: { user_id: userId } },
			{ $unwind: "$product_folders" },
			{ $match: { "product_folders._id": folderId } },
			{
				$lookup: {
					from: "products",
					localField: "product_folders.products",
					foreignField: "_id",
					as: "bookmarkedProducts",
				},
			},
			{
				$project: {
					_id: 0,
					products: {
						$map: {
							input: "$bookmarkedProducts",
							as: "product",
							in: {
								_id: "$$product._id",
								product_plan_number: "$$product.product_plan_number",
								product_name: "$$product.product_name",
								product_description: "$$product.product_description",
								status: "$$product.status",
								version: "$$product.version",
								folder_name: "$product_folders.folder_name",
							},
						},
					},
				},
			},
		];

		const result = await db.collection<UserBookmarks>("bookmarks").aggregate(pipeline).toArray();

		if (result.length === 0) return ResponseWrapper.notFound("Bookmark folder not found or is empty.");


		const products = result[0].products;

		return ResponseWrapper.success({
			message: "Products fetched from bookmark folder successfully.",
			products,
		});
	} catch (error) {
		console.error("Error in getProductsFromBookmark:", error);
		return ResponseWrapper.internalServerError("An unknown error occurred while fetching products from the bookmark folder.");
	}
};