import { Db, ObjectId } from 'mongodb';
import type { Product, ProductTeamMember } from '../models/product';
import type { User } from '../models/user';
import { enrichUsersWithProfileAvatarUrls, type TenantUploadSigningOptions } from './s3-storage';
import { isWorkspaceAdmin, type TenantContext } from './tenantContext';

export type ProductRole = 'owner' | 'contributor' | 'admin' | 'viewer';

type ProductActor = Pick<TenantContext, 'userId' | 'cognitoGroups'>;
type ProductTeam = Pick<Product, 'owner_user_id' | 'contributor_user_ids'>;

export const PRODUCT_EDIT_FORBIDDEN_MESSAGE = 'Only the Product Owner, Contributors, or an admin can edit this product';

/** Thrown inside a transaction when the caller lost edit access after the first check; maps to 403. */
export class ProductAccessError extends Error {}

export const getProductRole = (user: ProductActor, product: ProductTeam): ProductRole => {
	if (product.owner_user_id?.equals(user.userId)) return 'owner';
	if (isWorkspaceAdmin(user.cognitoGroups)) return 'admin';
	if (product.contributor_user_ids?.some((id) => id.equals(user.userId))) return 'contributor';
	return 'viewer';
};

/**
 * Write filter that only matches products the caller may still edit when the write runs.
 * @param {ProductActor} user Caller
 * @return {Object} Empty for admins, otherwise an owner-or-contributor condition
 */
export const productEditorFilter = (user: ProductActor) =>
	isWorkspaceAdmin(user.cognitoGroups)
		? {}
		: { $and: [{ $or: [{ owner_user_id: user.userId }, { contributor_user_ids: user.userId }] }] };

export const canEditProduct = (user: ProductActor, product: ProductTeam) =>
	getProductRole(user, product) !== 'viewer';

export const canManageProductTeam = (user: ProductActor, product: ProductTeam) =>
	['owner', 'admin'].includes(getProductRole(user, product));

/**
 * Finds an active member of the workspace, used to validate owner and contributor picks.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace the member must belong to
 * @param {unknown} userId Requested user id
 * @return {Promise<User | null>} The active member, or null
 */
export const findActiveWorkspaceMember = async (db: Db, workspaceId: ObjectId, userId: unknown) => {
	if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return null;
	return db.collection<User>('users').findOne({ _id: new ObjectId(userId), workspaceId, status: 'active' });
};

const TEAM_MEMBER_PIPELINE = [{ $project: { name: 1, email: 1, profileAvatar: 1 } }];

/** Aggregation stages that add `owner`, `owner_name`, and `contributors` to products. */
export const productTeamLookupStages = [
	{ $lookup: { from: 'users', localField: 'owner_user_id', foreignField: '_id', as: 'owner', pipeline: TEAM_MEMBER_PIPELINE } },
	{ $lookup: { from: 'users', localField: 'contributor_user_ids', foreignField: '_id', as: 'contributors', pipeline: TEAM_MEMBER_PIPELINE } },
	{ $addFields: { owner: { $ifNull: [{ $first: '$owner' }, null] }, owner_name: { $first: '$owner.name' } } },
];

type WithTeamMembers = { owner?: ProductTeamMember | null; contributors?: ProductTeamMember[] };

/**
 * Replaces team members' avatar keys with signed URLs, signing each member once.
 * @param {T[]} products Products with `owner` and `contributors` from `productTeamLookupStages`
 * @param {TenantUploadSigningOptions} signingOptions Tenant signing options
 * @return {Promise<T[]>} Products with signed team avatars
 */
export const signProductTeamAvatars = async <T extends WithTeamMembers>(
	products: T[],
	signingOptions: TenantUploadSigningOptions,
): Promise<T[]> => {
	const members = new Map<string, ProductTeamMember>();
	for (const product of products) {
		for (const member of [product.owner, ...(product.contributors ?? [])]) {
			if (member) members.set(member._id.toString(), member);
		}
	}
	const signed = new Map((await enrichUsersWithProfileAvatarUrls([...members.values()], signingOptions))
		.map((member) => [member._id.toString(), member]));
	const sign = (member: ProductTeamMember) => signed.get(member._id.toString()) ?? member;

	return products.map((product) => ({
		...product,
		owner: product.owner ? sign(product.owner) : product.owner,
		contributors: product.contributors?.map(sign),
	}));
};
