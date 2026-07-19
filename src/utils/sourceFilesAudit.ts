import type { Db, ObjectId } from 'mongodb';
import type { Product } from '../models/product';
import { tenantObjectIdFilter } from './tenantContext';

export const resolveWorkspaceProductName = async (
	db: Db,
	productId: ObjectId | null | undefined,
	workspaceId: ObjectId,
): Promise<string | null> => {
	if (!productId) return null;

	const product = await db.collection<Product>('products').findOne(
		tenantObjectIdFilter(productId, workspaceId),
		{ projection: { product_name: 1 } },
	);

	const name = product?.product_name;
	return typeof name === 'string' && name.trim() ? name.trim() : null;
};
