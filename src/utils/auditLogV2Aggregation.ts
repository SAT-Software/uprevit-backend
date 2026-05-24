import {
	AUDIT_LOG_V2_COLLECTION,
	type AuditAction,
	type AuditScopeType,
} from '../models/auditLogV2';

type LegacyAuditMode = 'activity' | 'archive';

type BuildLegacyAuditLookupStageInput = {
	scopeType: Extract<AuditScopeType, 'product' | 'project' | 'department'>;
	mode?: LegacyAuditMode;
	updateActions?: AuditAction[];
};

const PRODUCT_CREATION_EVENT_KEYS = ['product.created', 'product.version.created'] as const;

export const buildLegacyAuditLookupStage = ({
	scopeType,
	mode = 'activity',
	updateActions = ['update'],
}: BuildLegacyAuditLookupStageInput): Record<string, unknown> => {
	if (mode === 'archive') {
		return {
			$lookup: {
				from: AUDIT_LOG_V2_COLLECTION,
				let: { entityIdString: { $toString: '$_id' } },
				pipeline: [
					{
						$match: {
							$expr: {
								$and: [
									{ $eq: ['$scope.type', scopeType] },
									{ $eq: ['$scope.id', '$$entityIdString'] },
									{ $eq: ['$action', 'archive'] },
								],
							},
						},
					},
					{ $sort: { occurredAt: -1 } },
					{ $limit: 1 },
					{
						$project: {
							_id: 1,
							entity: '$scope.type',
							entityId: '$scope.id',
							action: '$action',
							actionBy: '$actor.name',
							actionAt: '$occurredAt',
							active: { $literal: true },
						},
					},
				],
				as: 'auditLogs',
			},
		};
	}

	const actionFilters = Array.from(new Set(['create', ...updateActions]));
	const legacyCreateCondition = scopeType === 'product'
		? { $in: ['$eventKey', PRODUCT_CREATION_EVENT_KEYS] }
		: { $eq: ['$action', 'create'] };

	return {
		$lookup: {
			from: AUDIT_LOG_V2_COLLECTION,
			let: { entityIdString: { $toString: '$_id' } },
			pipeline: [
				{
					$match: {
						$expr: {
							$and: [
								{ $eq: ['$scope.type', scopeType] },
								{ $eq: ['$scope.id', '$$entityIdString'] },
								{ $in: ['$action', actionFilters] },
							],
						},
					},
				},
				{
					$addFields: {
						legacyAction: {
							$cond: [legacyCreateCondition, 'create', 'update'],
						},
					},
				},
				{ $sort: { occurredAt: -1 } },
				{
					$group: {
						_id: '$legacyAction',
						log: { $first: '$$ROOT' },
					},
				},
				{ $replaceRoot: { newRoot: '$log' } },
				{
					$project: {
						_id: 1,
						entity: '$scope.type',
						entityId: '$scope.id',
						action: '$legacyAction',
						actionBy: '$actor.name',
						actionAt: '$occurredAt',
						active: { $literal: true },
					},
				},
				{ $sort: { actionAt: -1 } },
			],
			as: 'auditLogs',
		},
	};
};
