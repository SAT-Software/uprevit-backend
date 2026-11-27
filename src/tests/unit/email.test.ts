import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const sendMock = jest.fn<(command: unknown, options?: unknown) => Promise<unknown>>();

jest.mock('@aws-sdk/client-ses', () => ({
	SESClient: jest.fn(() => ({ send: sendMock })),
	SendEmailCommand: jest.fn((input) => ({ input })),
}));

const { sendEmail } = require('../../utils/email');

describe('sendEmail', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			SES_FROM_ADDRESS: 'Uprevit <notifications@notify.uprevit.com>',
			APP_BASE_URL: 'https://app.uprevit.com',
		};
		sendMock.mockResolvedValue({});
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('preserves workspace notification email format without replyTo', async () => {
		const sent = await sendEmail({
			to: 'user@example.com',
			subject: 'Review assigned',
			title: 'You have a review',
			body: 'Please check product A.',
			link: '/products/123',
		});

		expect(sent).toBe(true);
		const command = (sendMock.mock.calls[0][0] as any).input;
		expect(command.Source).toBe('Uprevit <notifications@notify.uprevit.com>');
		expect(command.Destination).toEqual({ ToAddresses: ['user@example.com'] });
		expect(command.ReplyToAddresses).toBeUndefined();
		expect(command.Message.Body.Html.Data).toContain('Open in Uprevit');
		expect(command.Message.Body.Html.Data).toContain('activity in your Uprevit workspace');
	});

	it('escapes HTML in fields/body, strips CR/LF in headers, and sets ReplyToAddresses', async () => {
		const sent = await sendEmail({
			to: 'contact@uprevit.com',
			replyTo: 'alex@northwind.health\r\nBcc: evil@example.com',
			subject: '[Book a demo] <Northwind>\r\nInjected',
			title: 'New inquiry <script>alert(1)</script>',
			fields: [{ label: 'Company', value: '<b>Northwind</b> & Co.' }],
			body: 'Line 1\n<img src=x onerror=alert(1)>',
			footer: 'Sent from the contact form.',
		});

		expect(sent).toBe(true);
		const command = (sendMock.mock.calls[0][0] as any).input;
		expect(command.ReplyToAddresses).toEqual(['alex@northwind.health Bcc: evil@example.com']);
		expect(command.Message.Subject.Data).toBe('[Book a demo] <Northwind> Injected');
		expect(command.Message.Body.Html.Data).not.toContain('<script>');
		expect(command.Message.Body.Html.Data).not.toContain('<img src=x');
		expect(command.Message.Body.Html.Data).toContain('&lt;b&gt;Northwind&lt;/b&gt; &amp; Co.');
		expect(command.Message.Body.Html.Data).toContain('Sent from the contact form.');
		expect(command.Message.Body.Text.Data).toContain('Company: <b>Northwind</b> & Co.');
	});
});
