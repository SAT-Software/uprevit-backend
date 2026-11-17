import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const template = readFileSync(join(__dirname, '../../../template.yaml'), 'utf8');

const functionsDeclaring = (variable: string): string[] =>
	template
		.split(/^(?= {2}\w+:\n {4}Type: AWS::Serverless::Function)/m)
		.filter(block => block.includes(`          ${variable}:`))
		.map(block => block.match(/^ {2}(\w+):/)?.[1] ?? '');

describe('template Chargebee secret scoping', () => {
	it('keeps Chargebee settings out of Globals', () => {
		const globals = template.slice(template.indexOf('\nGlobals:'), template.indexOf('\nConditions:'));
		expect(globals).not.toContain('CHARGEBEE_');
	});

	it('scopes webhook credentials to the webhook function', () => {
		expect(functionsDeclaring('CHARGEBEE_WEBHOOK_USERNAME')).toEqual(['ChargebeeWebhookFunction']);
		expect(functionsDeclaring('CHARGEBEE_WEBHOOK_PASSWORD')).toEqual(['ChargebeeWebhookFunction']);
	});

	it('does not give the public health function the Chargebee API key', () => {
		expect(functionsDeclaring('CHARGEBEE_API_KEY')).not.toContain('HealthFunction');
		expect(functionsDeclaring('CHARGEBEE_API_KEY')).toContain('ChargebeeWebhookFunction');
	});
});
