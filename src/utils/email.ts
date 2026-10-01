import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const SEND_DEADLINE_MS = 5000;

const ses = new SESClient({
	region: process.env.AWS_REGION || 'us-east-1',
	maxAttempts: 2,
	requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
});

export type EmailMessage = {
	to: string;
	subject: string;
	title: string;
	body?: string;
	link?: string;
};

const escapeHtml = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Builds an absolute app URL from an in-app path.
 * @param {string} path In-app path such as `/products/123`
 * @return {string | undefined} Absolute URL, or undefined when APP_BASE_URL is not set
 */
export const appUrl = (path = '/') => {
	const base = process.env.APP_BASE_URL?.replace(/\/+$/, '');
	return base ? `${base}${path}` : undefined;
};

const renderEmail = ({ title, body, link }: EmailMessage) => {
	const logoUrl = appUrl('/uprevit-logo-black.png');
	const url = link ? appUrl(link) : undefined;

	return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
		<tr><td style="padding:32px;">
			${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="Uprevit" width="40" height="40" style="display:block;margin-bottom:24px;" />` : ''}
			<h1 style="margin:0 0 12px;font-size:18px;line-height:26px;font-weight:600;">${escapeHtml(title)}</h1>
			${body ? `<p style="margin:0 0 24px;font-size:14px;line-height:22px;color:#52525b;">${escapeHtml(body)}</p>` : ''}
			${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;border-radius:8px;">Open in Uprevit</a>` : ''}
		</td></tr>
	</table>
	<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:18px;color:#a1a1aa;text-align:center;">You received this email because of activity in your Uprevit workspace.</p>
</body>
</html>`;
};

/**
 * Sends a notification email through SES. Does nothing when SES_FROM_ADDRESS is not set.
 * @param {EmailMessage} message Email content and recipient
 * @return {Promise<boolean>} Whether the email was sent
 */
export const sendEmail = async (message: EmailMessage): Promise<boolean> => {
	const from = process.env.SES_FROM_ADDRESS;
	if (!from) return false;

	const url = message.link ? appUrl(message.link) : undefined;
	const text = [message.title, message.body, url ? `Open in Uprevit: ${url}` : undefined].filter(Boolean).join('\n\n');

	await ses.send(new SendEmailCommand({
		Source: from,
		Destination: { ToAddresses: [message.to] },
		Message: {
			Subject: { Data: message.subject, Charset: 'UTF-8' },
			Body: {
				Html: { Data: renderEmail(message), Charset: 'UTF-8' },
				Text: { Data: text, Charset: 'UTF-8' },
			},
		},
	}), { abortSignal: AbortSignal.timeout(SEND_DEADLINE_MS) });
	return true;
};
