import { ObjectId } from 'mongodb';


const REFERENCE_FIELDS = ['workspace_id', 'project_id', 'department_id'];

/**
 * @param obj - The object to deep copy
 * @returns A deep copy with fresh ObjectIds for all `_id` fields
 */
export function deepCopyWithFreshIds<T>(obj: T): T {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj !== 'object') {
		return obj;
	}

	if (obj instanceof Date) {
		return new Date(obj.getTime()) as T;
	}

	
	if (obj instanceof ObjectId) {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => deepCopyWithFreshIds(item)) as T;
	}


	const copy: Record<string, unknown> = {};

	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			const value = (obj as Record<string, unknown>)[key];

			if (key === '_id') {
				const parentId = value instanceof ObjectId ? value.toString() : value;
				copy['parent_id'] = parentId;
				copy[key] = new ObjectId();
			} else if (key === 'parent_id') {
				continue;
			} else if (REFERENCE_FIELDS.includes(key)) {
				copy[key] = value;
			} else {
				copy[key] = deepCopyWithFreshIds(value);
			}
		}
	}

	return copy as T;
}
