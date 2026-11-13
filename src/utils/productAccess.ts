import { Db, Document, ObjectId } from 'mongodb';
import type { Product, ProductTeamMember } from '../models/product';
import type { User, UserType } from '../models/user';
import { enrichUsersWithProfileAvatarUrls, type TenantUploadSigningOptions } from './s3-storage';
import { canEditWorkspaceData, isWorkspaceAdmin, READ_ONLY_MESSAGE, type TenantContext } from './tenantContext';
import { ARCHIVED_PRODUCT_MESSAGE, canCreateVersion, COMPLETION_TABS, isContentLocked } from './productLifecycle';
import { ResponseWrapper } from './responseWrapper';

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

type CapabilityActor = Pick<TenantContext, 'userId' | 'cognitoGroups' | 'userType'>;
type CapabilityProduct = ProductTeam & Pick<Product, 'status' | 'is_archived' | 'is_latest'> & Partial<Pick<Product, typeof COMPLETION_TABS[number]>>;

export type ProductCapabilities = {
	role: ProductRole;
	canEdit: boolean;
	canManageTeam: boolean;
	canSubmit: boolean;
	canReturnToDraft: boolean;
	canMarkTabIncomplete: boolean;
	canArchive: boolean;
	canCreateVersion: boolean;
	lockedReason: string | null;
};

const contentLockReason = (actor: CapabilityActor, product: CapabilityProduct, role: ProductRole) => {
	if (!canEditWorkspaceData(actor)) return READ_ONLY_MESSAGE;
	if (role === 'viewer') return PRODUCT_EDIT_FORBIDDEN_MESSAGE;
	if (product.is_archived) return ARCHIVED_PRODUCT_MESSAGE;
	if (product.status === 'released') return "Released versions can't be edited. Create a new version to make changes.";
	if (isContentLocked(product.status)) return "Obsolete versions can't be edited";
	return null;
};

/**
 * What the caller may do with a Product Version right now. Handlers enforce the same rules at write time.
 * @param {CapabilityActor} actor Caller
 * @param {CapabilityProduct} product Product Version with its team, status and archive flag
 * @return {ProductCapabilities} Allowed actions and, when content is locked, why
 */
export const getProductCapabilities = (actor: CapabilityActor, product: CapabilityProduct): ProductCapabilities => {
	const role = getProductRole(actor, product);
	const isEditor = canEditWorkspaceData(actor);
	const isAdmin = isEditor && isWorkspaceAdmin(actor.cognitoGroups);
	const lockedReason = contentLockReason(actor, product, role);
	const canEdit = lockedReason === null;
	return {
		role,
		canEdit,
		canManageTeam: isEditor && (role === 'owner' || role === 'admin') && Boolean(product.is_latest),
		canSubmit: canEdit && product.status === 'draft' && COMPLETION_TABS.every((tab) => product[tab]?.tab_completed),
		canReturnToDraft: canEdit && product.status === 'submitted',
		canMarkTabIncomplete: canEdit && product.status === 'draft',
		canArchive: isAdmin && !product.is_archived && product.status !== 'in_review',
		canCreateVersion: isEditor && role !== 'viewer' && canCreateVersion(product),
		lockedReason,
	};
};

/** Adds `capabilities` to each product for the caller. */
export const withProductCapabilities = <T extends Document>(actor: CapabilityActor, products: T[]) =>
	products.map((product) => ({ ...product, capabilities: getProductCapabilities(actor, product as unknown as CapabilityProduct) }));

/**
 * Response for a content edit the caller can't make, or null when the edit is allowed.
 * @param {CapabilityActor} actor Caller
 * @param {CapabilityProduct} product Product Version being edited
 * @return {APIGatewayProxyResult | null} 403 for missing access, 409 for a locked version
 */
export const denyProductContentEdit = (actor: CapabilityActor, product: CapabilityProduct) => {
	const { role, lockedReason } = getProductCapabilities(actor, product);
	if (!lockedReason) return null;
	if (!canEditWorkspaceData(actor) || role === 'viewer') return ResponseWrapper.forbidden(lockedReason);
	return ResponseWrapper.conflict(lockedReason);
};

/**
 * Finds an active member of the workspace with one of the given User Types, used to validate team and approver picks.
 * @param {Db} db Database handle
 * @param {ObjectId} workspaceId Workspace the member must belong to
 * @param {unknown} userId Requested user id
 * @param {UserType[]} userTypes User Types the member may have
 * @return {Promise<User | null>} The active member, or null
 */
export const findActiveWorkspaceMember = async (db: Db, workspaceId: ObjectId, userId: unknown, userTypes: UserType[]) => {
	if (typeof userId !== 'string' || !ObjectId.isValid(userId)) return null;
	return db.collection<User>('users').findOne({ _id: new ObjectId(userId), workspaceId, status: 'active', userType: { $in: userTypes } });
};

const TEAM_MEMBER_PIPELINE = [{ $project: { name: 1, email: 1, profileAvatar: 1, status: 1 } }];

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
