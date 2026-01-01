import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDb } from '../../utils/db';
import { ObjectId } from 'mongodb';
import { Product } from '../../models/product';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { authenticateRequest } from '../../utils/authUtils';
import { validateMissingFields, validateObjectIds } from '../../utils/validationUtils';
import { 
	validateConditions, 
	buildAggregationPipeline 
} from '../../utils/reports/queryBuilder';

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

		const page = input.pagination?.page || 1;
		const limit = Math.min(input.pagination?.limit || 10, 100);


		if (input.conditionLogic && !['AND', 'OR'].includes(input.conditionLogic)) 
			return ResponseWrapper.badRequest('conditionLogic must be either "AND" or "OR"');


		if (input.conditions && input.conditions.length > 0) {
			const conditionError = validateConditions(input.conditions);
			if (conditionError) return conditionError;
		}

		const workspaceId = ObjectId.createFromHexString(input.workspaceId);
		const pipeline = buildAggregationPipeline(input, workspaceId);

		const db = await getDb();
		const result = await db.collection<Product>('products').aggregate(pipeline).toArray();

		const products = result[0]?.data || [];
		const totalCount = result[0]?.metadata?.[0]?.total || 0;
		const totalPages = Math.ceil(totalCount / limit);

		const transformedProducts = products.map((p: any) => ({
			_id: p._id,
			product_name: p.product_name,
			product_plan_number: p.product_plan_number,
			department_id: p.department_id,
			project_id: p.project_id,
			status: p.status,
			target_date: p.target_date,
			version: p.version,
		}));

		const response = {
			message: 'Query executed successfully',
			result: {
				products: transformedProducts,
				pagination: {
					total: totalCount,
					page,
					limit,
					totalPages,
				},
			},
		};

		return ResponseWrapper.success(response);
	} catch (err) {
		console.error('Error in reports query handler:', err);
		return ResponseWrapper.internalServerError(err instanceof Error ? err : String(err));
	}
};
