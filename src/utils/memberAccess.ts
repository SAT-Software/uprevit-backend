import {
	AdminAddUserToGroupCommand,
	AdminRemoveUserFromGroupCommand,
	CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { Db, ObjectId } from 'mongodb';
import type { Product } from '../models/product';
import type { UserType } from '../models/user';
import { ACTIVE_WORKFLOW_STATUSES, WORKFLOWS_COLLECTION, type Workflow } from '../models/workflow';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });

const MEMBER_GROUPS = ['admin', 'user', 'approver', 'manager'] as const;

export type MemberAccess = { userType: UserType | null; isManager: boolean };

export type MemberAccessBlockers = {
	products: Array<{ _id: string; name: string; relationship: 'owner' | 'contributor' }>;
	workflows: Array<{ _id: string; numberLabel: string; name: string; relationship: 'initiator' | 'approver' }>;
};

/**
 * Cognito groups for a member: the base User Type, plus `manager` when they have Manager access.
 * @param {MemberAccess} access Base User Type and Manager flag
 * @return {string[]} Group names
 */
export const memberCognitoGroups = ({ userType, isManager }: MemberAccess): string[] =>
	[...(userType ? [userType] : []), ...(isManager ? ['manager'] : [])];

/**
 * Adds the member to the groups for their access and removes them from the other member groups.
 * @param {string} email Cognito username
 * @param {MemberAccess | null} access Access to apply, or null to remove every member group
 */
export const syncMemberCognitoGroups = async (email: string, access: MemberAccess | null): Promise<void> => {
	const wanted = access ? memberCognitoGroups(access) : [];
	for (const group of MEMBER_GROUPS) {
		const input = { UserPoolId: process.env.USER_POOL_ID!, Username: email, GroupName: group };
		await cognito.send(wanted.includes(group) ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input));
	}
};

/**
 * Reads the access a workspace admin may assign: User, Approver or no base type, plus Manager. Admin is never accepted.
 * @param {unknown} userType Requested base type (`user`, `approver` or null)
 * @param {unknown} isManager Requested Manager flag
 * @return {MemberAccess | string} The access, or an error message
 */
export const parseAssignableMemberAccess = (userType: unknown, isManager: unknown): MemberAccess | string => {
	if (userType !== null && userType !== 'user' && userType !== 'approver') return 'User Type must be User, Approver or none';
	if (typeof isManager !== 'boolean') return 'isManager must be true or false';
	if (!userType && !isManager) return 'Pick a User Type, Manager access, or both';
	return { userType, isManager };
};

/**
 * Reads the access a workspace admin may give another Admin: Admin stays, and only Manager access changes.
 * @param {unknown} isManager Requested Manager flag
 * @return {MemberAccess | string} The access, or an error message
 */
export const parseAdminMemberAccess = (isManager: unknown): MemberAccess | string =>
	typeof isManager === 'boolean' ? { userType: 'admin', isManager } : 'isManager must be true or false';

/**
 * Lists what keeps a member from losing edit access: Products they own or contribute to and active workflows they
 * initiated. Without any base type they also cannot stay an approver, so active assignments block too.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace id
 * @param {ObjectId} userId Member id
 * @param {UserType | null} nextUserType The base type the member would get
 * @return {Promise<MemberAccessBlockers>} Items to reassign first
 */
export const findMemberAccessBlockers = async (
	db: Db,
	workspaceId: ObjectId,
	userId: ObjectId,
	nextUserType: UserType | null,
): Promise<MemberAccessBlockers> => {
	const [products, workflows] = await Promise.all([
		db.collection<Product>('products')
			.find(
				{ workspace_id: workspaceId, is_latest: true, $or: [{ owner_user_id: userId }, { contributor_user_ids: userId }] },
				{ projection: { product_name: 1, owner_user_id: 1 } },
			)
			.toArray(),
		db.collection<Workflow>(WORKFLOWS_COLLECTION)
			.find(
				{
					workspaceId,
					status: { $in: ACTIVE_WORKFLOW_STATUSES },
					$or: [{ 'initiator.userId': userId }, ...(nextUserType ? [] : [{ 'assignments.userId': userId }])],
				},
				{ projection: { numberLabel: 1, name: 1, initiator: 1 } },
			)
			.toArray(),
	]);

	return {
		products: products.map((product) => ({
			_id: product._id!.toString(),
			name: product.product_name,
			relationship: product.owner_user_id?.equals(userId) ? 'owner' : 'contributor',
		})),
		workflows: workflows.map((workflow) => ({
			_id: workflow._id!.toString(),
			numberLabel: workflow.numberLabel,
			name: workflow.name,
			relationship: workflow.initiator.userId.equals(userId) ? 'initiator' : 'approver',
		})),
	};
};
