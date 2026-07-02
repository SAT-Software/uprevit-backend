import { AuditAction, AuditLogV2Change } from '../models/auditLogV2';

type SummaryContext = {
	eventKey: string;
	action: AuditAction;
	changes: AuditLogV2Change[];
	meta?: Record<string, unknown>;
};

type SummaryBuilder = (context: SummaryContext) => string;

const pickText = (meta: Record<string, unknown> | undefined, keys: string[]): string | undefined => {
	if (!meta) return undefined;

	for (const key of keys) {
		const value = meta[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}

	return undefined;
};

const formatFieldName = (path: string) => {
	const normalized = path
		.split('.')
		.at(-1)
		?.replace(/_/g, ' ')
		.replace(/\[(\d+)\]/g, '');

	return normalized ?? path;
};

const listChangedFields = (changes: AuditLogV2Change[]) => {
	if (!changes.length) return '';

	const labels = Array.from(new Set(changes.map((change) => formatFieldName(change.path)))).filter(Boolean);
	if (!labels.length) return '';

	return ` (${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ', ...' : ''})`;
};

const subjectForScope = (eventKey: string) => {
	if (eventKey.startsWith('department.')) return 'department';
	if (eventKey.startsWith('project.')) return 'project';
	if (eventKey.startsWith('product.')) return 'product';
	if (eventKey.startsWith('source_files.')) return 'source item';
	return 'record';
};

const productItemSummary = (
	verb: 'added' | 'updated' | 'deleted',
	label: string,
	changes: AuditLogV2Change[],
) => `${verb} ${label}${verb === 'updated' ? listChangedFields(changes) : ''}`;

const summaryBuilders: Record<string, SummaryBuilder> = {
	'department.created': ({ meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return `created department${name ? ` "${name}"` : ''}`;
	},
	'department.updated': ({ meta, changes }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return `updated department${name ? ` "${name}"` : ''}${listChangedFields(changes)}`;
	},
	'department.archived': ({ meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return `archived department${name ? ` "${name}"` : ''}`;
	},
	'department.restored': ({ meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return `restored department${name ? ` "${name}"` : ''}`;
	},
	'project.created': ({ meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return `created project${name ? ` "${name}"` : ''}`;
	},
	'project.updated': ({ meta, changes }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return `updated project${name ? ` "${name}"` : ''}${listChangedFields(changes)}`;
	},
	'project.archived': ({ meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return `archived project${name ? ` "${name}"` : ''}`;
	},
	'project.restored': ({ meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return `restored project${name ? ` "${name}"` : ''}`;
	},
	'product.created': ({ meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return `created product${name ? ` "${name}"` : ''}`;
	},
	'product.updated': ({ meta, changes }) => {
		const name = pickText(meta, ['productName', 'name']);
		return `updated product${name ? ` "${name}"` : ''}${listChangedFields(changes)}`;
	},
	'product.submitted': ({ meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return `submitted product${name ? ` "${name}"` : ''}`;
	},
	'product.archived': ({ meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return `archived product${name ? ` "${name}"` : ''}`;
	},
	'product.restored': ({ meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return `restored product${name ? ` "${name}"` : ''}`;
	},
	'product.version.created': ({ meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		const fromVersion = meta?.fromVersion;
		const toVersion = meta?.toVersion;
		const versionText = typeof fromVersion === 'number' && typeof toVersion === 'number'
			? ` from v${fromVersion} to v${toVersion}`
			: '';
		return `created a new version${versionText}${name ? ` for product "${name}"` : ''}`;
	},
	'product.product_information.updated': ({ changes }) =>
		`updated product information${listChangedFields(changes)}`,
	'product.product_information.custom_field.added': () =>
		'added custom field in product information',
	'product.product_information.custom_field.updated': ({ changes }) =>
		`updated custom field in product information${listChangedFields(changes)}`,
	'product.product_information.custom_field.deleted': () =>
		'deleted custom field from product information',
	'product.product_information.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} product information tab as complete`,
	'product.compliance_item.added': () => productItemSummary('added', 'compliance item', []),
	'product.compliance_item.updated': ({ changes }) => productItemSummary('updated', 'compliance item', changes),
	'product.compliance_item.deleted': () => productItemSummary('deleted', 'compliance item', []),
	'product.compliance_information.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} compliance information tab as complete`,
	'product.languages_information.updated': ({ changes }) =>
		`updated languages information${listChangedFields(changes)}`,
	'product.label_component.added': () => productItemSummary('added', 'label component', []),
	'product.label_component.updated': ({ changes }) => productItemSummary('updated', 'label component', changes),
	'product.label_component.deleted': () => productItemSummary('deleted', 'label component', []),
	'product.label_components.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} label components tab as complete`,
	'product.symbol_graphic.added': () => productItemSummary('added', 'symbol/graphic item', []),
	'product.symbol_graphic.updated': ({ changes }) => productItemSummary('updated', 'symbol/graphic item', changes),
	'product.symbol_graphic.deleted': () => productItemSummary('deleted', 'symbol/graphic item', []),
	'product.symbol_graphics.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} symbols and graphics tab as complete`,
	'product.product_specification.added': () => productItemSummary('added', 'product specification data', []),
	'product.product_specification.updated': ({ changes }) => productItemSummary('updated', 'product specification data', changes),
	'product.product_specification.deleted': () => productItemSummary('deleted', 'product specification data', []),
	'product.product_specifications.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} product specifications tab as complete`,
	'product.operational_parameter.added': () => productItemSummary('added', 'operational parameter data', []),
	'product.operational_parameter.updated': ({ changes }) => productItemSummary('updated', 'operational parameter data', changes),
	'product.operational_parameter.deleted': () => productItemSummary('deleted', 'operational parameter data', []),
	'product.operational_parameters.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} operational parameters tab as complete`,
	'product.label_tag.added': () => productItemSummary('added', 'label tag', []),
	'product.label_tag.updated': ({ changes }) => productItemSummary('updated', 'label tag', changes),
	'product.label_tag.deleted': () => productItemSummary('deleted', 'label tag', []),
	'product.label_tag.tagged_image.updated': ({ changes }) =>
		`updated label tag tagged image${listChangedFields(changes)}`,
	'product.label_tag.legend.updated': ({ changes }) =>
		`updated label tag legend${listChangedFields(changes)}`,
	'product.label_tags.completion.updated': ({ meta }) =>
		`${meta?.tabCompleted ? 'marked' : 'unmarked'} label tags tab as complete`,
	'source_files.folder.created': ({ meta }) => `created folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''}`,
	'source_files.folder.renamed': ({ meta }) => {
		const from = pickText(meta, ['fromName']);
		const to = pickText(meta, ['toName', 'folderName', 'name']);
		if (from && to) return `renamed folder from "${from}" to "${to}"`;
		return `renamed folder${to ? ` to "${to}"` : ''}`;
	},
	'source_files.folder.deleted': ({ meta }) => `deleted folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''}`,
	'source_files.folder.product_linked': ({ meta }) => `linked folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''} to a product`,
	'source_files.folder.product_unlinked': ({ meta }) => `unlinked folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''} from product`,
	'source_files.file.uploaded': ({ meta }) => `uploaded file${pickText(meta, ['fileName', 'name']) ? ` "${pickText(meta, ['fileName', 'name'])}"` : ''}`,
	'source_files.file.deleted': ({ meta }) => `deleted file${pickText(meta, ['fileName', 'name']) ? ` "${pickText(meta, ['fileName', 'name'])}"` : ''}`,
};

export const buildAuditEventSummary = (context: SummaryContext): string => {
	const builder = summaryBuilders[context.eventKey];
	const summary = builder
		? builder(context)
		: (() => {
			const subject = subjectForScope(context.eventKey);
			const changed = listChangedFields(context.changes);

			switch (context.action) {
			case 'create':
				return `created ${subject}`;
			case 'update':
				return `updated ${subject}${changed}`;
			case 'delete':
				return `deleted ${subject}`;
			case 'archive':
				return `archived ${subject}`;
			case 'restore':
				return `restored ${subject}`;
			case 'submit':
				return `submitted ${subject}`;
			case 'move':
				return `moved ${subject}`;
			case 'link':
				return `linked ${subject}`;
			case 'unlink':
				return `unlinked ${subject}`;
			default:
				return `updated ${subject}`;
			}
		})();

	return summary.charAt(0).toUpperCase() + summary.slice(1);
};
