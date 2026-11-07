import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { AuditLogAction } from '../../models/auditLog';
import { EDITOR_USER_TYPES, type User } from '../../models/user';
import { updateAuditLog } from '../../utils/auditLog';
import { getDb, withTransaction } from '../../utils/db';
import { logError } from '../../utils/logger';
import { findMemberAccessBlockers, parseAdminMemberAccess, parseAssignableMemberAccess, syncMemberCognitoGroups, type MemberAccess } from '../../utils/memberAccess';
import { assertSeatActivationAllowed, verifySeatLimitAfterActivation } from '../../utils/billing/enforcement';
import { seatClassForUserType } from '../../utils/billing/usageRecording';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { isWorkspaceAdmin, requireTenantContext, tenantUserIdFilter } from '../../utils/tenantContext';
import { withTelemetry } from '../../utils/telemetry';
import { touchActiveWorkflows } from '../../utils/workflowAssignments';

/**
 * Changes a member's base User Type (User, Approver or none) and Manager access. Admins keep Admin access, which only
 * platform operators change, and can only gain or lose Manager access. Losing edit access is blocked while the member is on a Product team or initiates an active
 * workflow, and losing every base type is blocked while they are an approver in one. With `dryRun: true` it only
 * returns those blockers without changing anything.
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @return {Promise<APIGatewayProxyResult>} API Gateway Lambda Proxy Output Format
 */
export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		const tenantResult = await requireTenantContext(event);
		if (!tenantResult.ok) return tenantResult.response;

		const { context } = tenantResult;
		if (!isWorkspaceAdmin(context.cognitoGroups)) return ResponseWrapper.forbidden('Insufficient permissions');

		const id = event.pathParameters?.id;
		if (!id || !ObjectId.isValid(id)) return ResponseWrapper.badRequest('A valid user id is required');

		const input = JSON.parse(event.body || '{}');
		const db = await getDb();
		const users = db.collection<User>('users');
		const target = await users.findOne(tenantUserIdFilter(id, context.workspaceId));
		if (!target || target.status === 'inactive') return ResponseWrapper.notFound('Member not found');
		if (target.userType === 'admin' && input.userType !== 'admin') {
			return ResponseWrapper.forbidden('Only platform operators can change Admin access');
		}

		const access = target.userType === 'admin'
			? parseAdminMemberAccess(input.isManager)
			: parseAssignableMemberAccess(input.userType, input.isManager);
		if (typeof access === 'string') return ResponseWrapper.badRequest(access);

		const blockers = !access.userType || !EDITOR_USER_TYPES.includes(access.userType)
			? await findMemberAccessBlockers(db, context.workspaceId, target._id!, access.userType)
			: { products: [], workflows: [] };
		if (input.dryRun === true) return ResponseWrapper.success({ blockers });
		if (blockers.products.length > 0 || blockers.workflows.length > 0) {
			return ResponseWrapper.conflict('Reassign this member\'s Products and workflows first', { blockers });
		}
		const seatClass = seatClassForUserType(access.userType);
		const takesNewSeat = target.status === 'active' && seatClass !== seatClassForUserType(target.userType);
		if (takesNewSeat) {
			const seatCheck = await assertSeatActivationAllowed(context.workspaceId, seatClass);
			if (!seatCheck.allowed) return ResponseWrapper.forbidden(seatCheck.reason);
		}

		await syncMemberCognitoGroups(target.email, access);
		await withTransaction(async (txDb, session) => {
			await txDb.collection<User>('users').updateOne({ _id: target._id }, { $set: access }, { session });
			await touchActiveWorkflows(txDb, context.workspaceId, { 'assignments.userId': target._id }, session);
		});

		if (takesNewSeat) {
			const postChangeCheck = await verifySeatLimitAfterActivation(context.workspaceId, seatClass);
			if (!postChangeCheck.allowed) {
				const previousAccess: MemberAccess = {
					userType: target.userType === undefined ? 'user' : target.userType,
					isManager: target.isManager === true,
				};
				const restored = await users.updateOne({ _id: target._id, ...access }, { $set: previousAccess });
				if (restored.modifiedCount > 0) await syncMemberCognitoGroups(target.email, previousAccess);
				return ResponseWrapper.forbidden(postChangeCheck.reason);
			}
		}

		await updateAuditLog({
			entity: 'user',
			entityId: id,
			action: AuditLogAction.UPDATE,
			actionBy: context.userId.toString(),
			actionAt: new Date(),
			active: true,
		});

		return ResponseWrapper.success({ message: 'Member access updated', user: { ...target, ...access } });
	} catch (err) {
		if (err instanceof SyntaxError) return ResponseWrapper.badRequest('Invalid JSON body');
		logError('Update user access handler failed', err);
		return ResponseWrapper.internalServerError('Failed to update member access');
	}
});
