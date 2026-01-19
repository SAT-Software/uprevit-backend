import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { getDb } from "../../utils/db";
import { ObjectId } from "mongodb";
import { authenticateRequest } from "../../utils/authUtils";
import { ResponseWrapper } from "../../utils/responseWrapper";
import { validateMissingFields } from "../../utils/validationUtils";
import { updateAuditLog } from "../../utils/auditLog";
import { AuditLogAction } from "../../models/auditLog";

/**
 * @param {APIGatewayProxyEvent} event
 * @return {Promise<APIGatewayProxyResult>}
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const auth = await authenticateRequest(event);
		if (!auth.isValid) return ResponseWrapper.unauthorized("Invalid authentication payload");


		if (!event.body) return ResponseWrapper.badRequest("Request body is required.");


		const input = JSON.parse(event.body);

		const validationResult = validateMissingFields({ name: input.name, userId: input.user_id });
		if (validationResult) return validationResult;


		const db = await getDb();

		// 2. Update user profile in MongoDB
		const updateResult = await db.collection("users").updateOne(
			{ _id: new ObjectId(input.user_id as string) },
			{ $set: { name: input.name, profileAvatar: input.profileAvatar || '', designation: input.designation || '', location: input.location || '', status: 'active' } }
		);

		if (updateResult.modifiedCount === 0) {
			return ResponseWrapper.notFound("User not found or no changes were made.");
		}
        
		await updateAuditLog({
			entity: 'user',
			entityId: input.user_id as string,
			action: AuditLogAction.UPDATE,
			actionBy: input.name,
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({ message: "Profile updated successfully." });

	} catch (error) {
		console.error('Onboard and update invited user handler failed');
		return ResponseWrapper.internalServerError('Failed to update profile');
	}
};