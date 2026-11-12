import { ObjectId } from 'mongodb';
import { describe, expect, it, jest } from '@jest/globals';

const { getProductTeams } = require('../../utils/workflows');

const user = (id: ObjectId, name: string) => ({ _id: id, name, email: `${name}@example.com` });

describe('getProductTeams', () => {
	it('loads every product team with one users query and keeps each relationship per product', async () => {
		const ownerA = new ObjectId();
		const shared = new ObjectId();
		const users = [user(ownerA, 'A'), user(shared, 'B')];
		const find = jest.fn(() => ({ toArray: jest.fn(async () => users) }));
		const db = { collection: jest.fn(() => ({ find })) } as any;

		const teams = await getProductTeams(db, new ObjectId(), [
			{ owner_user_id: ownerA, contributor_user_ids: [shared] },
			{ owner_user_id: shared, contributor_user_ids: [] },
		]);

		expect(find).toHaveBeenCalledTimes(1);
		expect(teams[0].map((member: any) => member.relationship)).toEqual(['product_owner', 'product_contributor']);
		expect(teams[0][0]._id.equals(ownerA)).toBe(true);
		expect(teams[1]).toHaveLength(1);
		expect(teams[1][0]._id.equals(shared)).toBe(true);
		expect(teams[1][0].relationship).toBe('product_owner');
	});

	it('returns empty teams without a query when nobody is assigned', async () => {
		const find = jest.fn();
		const db = { collection: jest.fn(() => ({ find })) } as any;

		expect(await getProductTeams(db, new ObjectId(), [{}])).toEqual([[]]);
		expect(find).not.toHaveBeenCalled();
	});
});
