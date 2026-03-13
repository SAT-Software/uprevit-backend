import { AuditAction, AuditLogV2Change } from '../models/auditLogV2';

type SummaryContext = {
	eventKey: string;
	action: AuditAction;
	changes: AuditLogV2Change[];
	meta?: Record<string, unknown>;
	actorName: string;
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

const withActor = (actorName: string, message: string) => `${actorName} ${message}`;

const productItemSummary = (
	actorName: string,
	verb: 'added' | 'updated' | 'deleted',
	label: string,
	changes: AuditLogV2Change[],
) => withActor(actorName, `${verb} ${label}${verb === 'updated' ? listChangedFields(changes) : ''}`);

const summaryBuilders: Record<string, SummaryBuilder> = {
	'department.created': ({ actorName, meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return withActor(actorName, `created department${name ? ` "${name}"` : ''}`);
	},
	'department.updated': ({ actorName, meta, changes }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return withActor(actorName, `updated department${name ? ` "${name}"` : ''}${listChangedFields(changes)}`);
	},
	'department.archived': ({ actorName, meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return withActor(actorName, `archived department${name ? ` "${name}"` : ''}`);
	},
	'department.restored': ({ actorName, meta }) => {
		const name = pickText(meta, ['departmentName', 'name']);
		return withActor(actorName, `restored department${name ? ` "${name}"` : ''}`);
	},
	'project.created': ({ actorName, meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return withActor(actorName, `created project${name ? ` "${name}"` : ''}`);
	},
	'project.updated': ({ actorName, meta, changes }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return withActor(actorName, `updated project${name ? ` "${name}"` : ''}${listChangedFields(changes)}`);
	},
	'project.archived': ({ actorName, meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return withActor(actorName, `archived project${name ? ` "${name}"` : ''}`);
	},
	'project.restored': ({ actorName, meta }) => {
		const name = pickText(meta, ['projectName', 'name']);
		return withActor(actorName, `restored project${name ? ` "${name}"` : ''}`);
	},
	'product.created': ({ actorName, meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return withActor(actorName, `created product${name ? ` "${name}"` : ''}`);
	},
	'product.updated': ({ actorName, meta, changes }) => {
		const name = pickText(meta, ['productName', 'name']);
		return withActor(actorName, `updated product${name ? ` "${name}"` : ''}${listChangedFields(changes)}`);
	},
	'product.submitted': ({ actorName, meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return withActor(actorName, `submitted product${name ? ` "${name}"` : ''}`);
	},
	'product.archived': ({ actorName, meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return withActor(actorName, `archived product${name ? ` "${name}"` : ''}`);
	},
	'product.restored': ({ actorName, meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		return withActor(actorName, `restored product${name ? ` "${name}"` : ''}`);
	},
	'product.version.created': ({ actorName, meta }) => {
		const name = pickText(meta, ['productName', 'name']);
		const fromVersion = meta?.fromVersion;
		const toVersion = meta?.toVersion;
		const versionText = typeof fromVersion === 'number' && typeof toVersion === 'number'
			? ` from v${fromVersion} to v${toVersion}`
			: '';
		return withActor(actorName, `created a new version${versionText}${name ? ` for product "${name}"` : ''}`);
	},
	'product.product_information.updated': ({ actorName, changes }) =>
		withActor(actorName, `updated product information${listChangedFields(changes)}`),
	'product.product_information.custom_field.added': ({ actorName }) =>
		withActor(actorName, 'added custom field in product information'),
	'product.product_information.custom_field.updated': ({ actorName, changes }) =>
		withActor(actorName, `updated custom field in product information${listChangedFields(changes)}`),
	'product.product_information.custom_field.deleted': ({ actorName }) =>
		withActor(actorName, 'deleted custom field from product information'),
	'product.product_information.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} product information tab as complete`),
	'product.compliance_item.added': ({ actorName }) => productItemSummary(actorName, 'added', 'compliance item', []),
	'product.compliance_item.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'compliance item', changes),
	'product.compliance_item.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'compliance item', []),
	'product.compliance_information.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} compliance information tab as complete`),
	'product.languages_information.updated': ({ actorName, changes }) =>
		withActor(actorName, `updated languages information${listChangedFields(changes)}`),
	'product.label_component.added': ({ actorName }) => productItemSummary(actorName, 'added', 'label component', []),
	'product.label_component.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'label component', changes),
	'product.label_component.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'label component', []),
	'product.label_components.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} label components tab as complete`),
	'product.symbol_graphic.added': ({ actorName }) => productItemSummary(actorName, 'added', 'symbol/graphic item', []),
	'product.symbol_graphic.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'symbol/graphic item', changes),
	'product.symbol_graphic.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'symbol/graphic item', []),
	'product.symbol_graphics.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} symbols and graphics tab as complete`),
	'product.product_specification.added': ({ actorName }) => productItemSummary(actorName, 'added', 'product specification data', []),
	'product.product_specification.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'product specification data', changes),
	'product.product_specification.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'product specification data', []),
	'product.product_specifications.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} product specifications tab as complete`),
	'product.operational_parameter.added': ({ actorName }) => productItemSummary(actorName, 'added', 'operational parameter data', []),
	'product.operational_parameter.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'operational parameter data', changes),
	'product.operational_parameter.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'operational parameter data', []),
	'product.operational_parameters.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} operational parameters tab as complete`),
	'product.label_tag.added': ({ actorName }) => productItemSummary(actorName, 'added', 'label tag', []),
	'product.label_tag.updated': ({ actorName, changes }) => productItemSummary(actorName, 'updated', 'label tag', changes),
	'product.label_tag.deleted': ({ actorName }) => productItemSummary(actorName, 'deleted', 'label tag', []),
	'product.label_tag.tagged_image.updated': ({ actorName, changes }) =>
		withActor(actorName, `updated label tag tagged image${listChangedFields(changes)}`),
	'product.label_tag.legend.updated': ({ actorName, changes }) =>
		withActor(actorName, `updated label tag legend${listChangedFields(changes)}`),
	'product.label_tags.completion.updated': ({ actorName, meta }) =>
		withActor(actorName, `${meta?.tabCompleted ? 'marked' : 'unmarked'} label tags tab as complete`),
	'source_files.folder.created': ({ actorName, meta }) => withActor(actorName, `created folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''}`),
	'source_files.folder.renamed': ({ actorName, meta }) => {
		const from = pickText(meta, ['fromName']);
		const to = pickText(meta, ['toName', 'folderName', 'name']);
		if (from && to) return withActor(actorName, `renamed folder from "${from}" to "${to}"`);
		return withActor(actorName, `renamed folder${to ? ` to "${to}"` : ''}`);
	},
	'source_files.folder.deleted': ({ actorName, meta }) => withActor(actorName, `deleted folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''}`),
	'source_files.folder.product_linked': ({ actorName, meta }) => withActor(actorName, `linked folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''} to a product`),
	'source_files.folder.product_unlinked': ({ actorName, meta }) => withActor(actorName, `unlinked folder${pickText(meta, ['folderName', 'name']) ? ` "${pickText(meta, ['folderName', 'name'])}"` : ''} from product`),
	'source_files.file.uploaded': ({ actorName, meta }) => withActor(actorName, `uploaded file${pickText(meta, ['fileName', 'name']) ? ` "${pickText(meta, ['fileName', 'name'])}"` : ''}`),
	'source_files.file.deleted': ({ actorName, meta }) => withActor(actorName, `deleted file${pickText(meta, ['fileName', 'name']) ? ` "${pickText(meta, ['fileName', 'name'])}"` : ''}`),
};

export const buildAuditEventSummary = (context: SummaryContext): string => {
	const builder = summaryBuilders[context.eventKey];
	if (builder) return builder(context);

	const subject = subjectForScope(context.eventKey);
	const changed = listChangedFields(context.changes);

	switch (context.action) {
	case 'create':
		return withActor(context.actorName, `created ${subject}`);
	case 'update':
		return withActor(context.actorName, `updated ${subject}${changed}`);
	case 'delete':
		return withActor(context.actorName, `deleted ${subject}`);
	case 'archive':
		return withActor(context.actorName, `archived ${subject}`);
	case 'restore':
		return withActor(context.actorName, `restored ${subject}`);
	case 'submit':
		return withActor(context.actorName, `submitted ${subject}`);
	case 'move':
		return withActor(context.actorName, `moved ${subject}`);
	case 'link':
		return withActor(context.actorName, `linked ${subject}`);
	case 'unlink':
		return withActor(context.actorName, `unlinked ${subject}`);
	default:
		return withActor(context.actorName, `updated ${subject}`);
	}
};
