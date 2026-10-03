import { WORKFLOW_COMPLETION_MODES, type WorkflowCompletionMode } from '../models/workflow';

const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 1000;

type WorkflowDetails = { name?: string; description?: string; completionMode?: WorkflowCompletionMode };

/**
 * Parses a request body that must be a JSON object. Throws `SyntaxError` for invalid JSON.
 * @param {string} body Raw request body
 * @return {Record<string, unknown> | null} The object, or null for arrays, primitives and null
 */
export const parseJsonObject = (body: string): Record<string, unknown> | null => {
	const value: unknown = JSON.parse(body);
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
};

/**
 * Validates workflow name, description and completion mode from a request body.
 * @param {Record<string, unknown>} input Request body
 * @param {Object} options `required` makes name and description mandatory
 * @return {Object} The trimmed values, or an error message
 */
export const parseWorkflowDetails = (
	input: Record<string, unknown>,
	{ required }: { required: boolean },
): { value: WorkflowDetails } | { error: string } => {
	const value: WorkflowDetails = {};

	for (const [key, label, max] of [['name', 'Name', NAME_MAX_LENGTH], ['description', 'Description', DESCRIPTION_MAX_LENGTH]] as const) {
		const raw = input[key];
		if (raw === undefined && !required) continue;
		const text = typeof raw === 'string' ? raw.trim() : '';
		if (!text) return { error: `${label} is required` };
		if (text.length > max) return { error: `${label} must be at most ${max} characters` };
		value[key] = text;
	}

	if (input.completionMode !== undefined) {
		if (!WORKFLOW_COMPLETION_MODES.includes(input.completionMode as WorkflowCompletionMode)) {
			return { error: `completionMode must be one of: ${WORKFLOW_COMPLETION_MODES.join(', ')}` };
		}
		value.completionMode = input.completionMode as WorkflowCompletionMode;
	}

	return { value };
};
