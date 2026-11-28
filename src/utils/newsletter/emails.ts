import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const SEND_DEADLINE_MS = 8000;

const sesv2 = new SESv2Client({
	region: process.env.AWS_REGION || 'us-east-1',
	maxAttempts: 2,
	requestHandler: { connectionTimeout: 2500, requestTimeout: 5000 },
});

export interface BlogPostEmailPayload {
	slug: string;
	title: string;
	description: string;
	date: string;
	author: string;
	category: string;
	readTime: string;
	url: string;
	excerpt?: string;
}

export interface RenderedNewsletterEmail {
	subject: string;
	html: string;
	text: string;
}

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

const sanitizeHeader = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();

const formatDisplayDate = (date: string): string => {
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	return parsed.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	});
};

const renderShell = (params: {
	preheader: string;
	headerRight?: string;
	siteBaseUrl: string;
	bodyHtml: string;
	footerHtml: string;
}): string => {
	const base = params.siteBaseUrl.replace(/\/+$/, '');
	const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base);
	const logoUrl = `${isLocalBase ? 'https://www.uprevit.com' : base}/logo.png`;
	const headerRightCell = params.headerRight
		? `<td align="right" valign="middle" style="font-size:12px;line-height:16px;color:#71717a;white-space:nowrap;">${escapeHtml(params.headerRight)}</td>`
		: '';

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<meta name="x-apple-disable-message-reformatting" />
	<meta name="color-scheme" content="light" />
	<title>Uprevit Blog</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;-webkit-font-smoothing:antialiased;">
	<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(params.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
		<tr>
			<td align="center" style="padding:36px 16px;">
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
					<tr>
						<td style="padding:0 4px 18px;">
							<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
								<tr>
									<td valign="middle">
										<a href="${escapeHtml(base)}/resources/blogs" style="text-decoration:none;color:#171717;">
											<table role="presentation" cellpadding="0" cellspacing="0" border="0">
												<tr>
													<td valign="middle" style="padding-right:10px;">
														<img src="${escapeHtml(logoUrl)}" alt="Uprevit" width="28" height="28" style="display:block;border-radius:7px;border:1px solid #e4e4e7;" />
													</td>
													<td valign="middle">
														<span style="font-size:15px;font-weight:600;letter-spacing:-0.02em;color:#171717;">Uprevit</span>
														<span style="font-size:14px;font-weight:400;color:#71717a;padding-left:6px;">Blog</span>
													</td>
												</tr>
											</table>
										</a>
									</td>
									${headerRightCell}
								</tr>
							</table>
						</td>
					</tr>
					<tr>
						<td style="background-color:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:32px 32px 30px;">
							${params.bodyHtml}
						</td>
					</tr>
					<tr>
						<td style="padding:20px 8px 0;text-align:center;">
							${params.footerHtml}
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
};

const renderPrimaryButton = (href: string, label: string): string =>
	`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
		<tr>
			<td align="center" bgcolor="#7f22fe" style="border-radius:8px;background-color:#7f22fe;border:1px solid #6a12dc;">
				<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:18px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
			</td>
		</tr>
	</table>`;

export const renderConfirmSubscriptionEmail = (params: {
	confirmUrl: string;
	siteBaseUrl: string;
	physicalAddress?: string;
}): RenderedNewsletterEmail => {
	const subject = 'Confirm your subscription to the Uprevit Blog';
	const addressLine = params.physicalAddress?.trim();

	const bodyHtml = `
		<p style="margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#7f22fe;">Double opt-in</p>
		<h1 style="margin:0 0 12px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.025em;color:#171717;">Confirm your blog subscription</h1>
		<p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#52525b;">Click below to confirm your email address. We&rsquo;ll send one short note whenever a new Uprevit blog post goes live&mdash;practical guides on medical device labeling, FDA QMSR, and EU MDR. No sales emails, and you can leave any time.</p>
		${renderPrimaryButton(params.confirmUrl, 'Confirm subscription')}
		<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #f0f0f2;font-size:13px;line-height:20px;color:#71717a;">This confirmation link expires in 24 hours. If you didn&rsquo;t ask to subscribe, you can safely ignore this email.</p>
		<p style="margin:10px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;word-break:break-all;">Or copy this link: <a href="${escapeHtml(params.confirmUrl)}" style="color:#71717a;text-decoration:underline;">${escapeHtml(params.confirmUrl)}</a></p>
	`;

	const footerHtml = `
		<p style="margin:0;font-size:12px;line-height:18px;color:#71717a;">Sent by Uprevit &middot; <a href="${escapeHtml(params.siteBaseUrl.replace(/\/+$/, ''))}" style="color:#71717a;text-decoration:underline;">uprevit.com</a></p>
		${addressLine ? `<p style="margin:6px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(addressLine)}</p>` : ''}
	`;

	const html = renderShell({
		preheader: 'Confirm your email to receive new posts from the Uprevit Blog.',
		siteBaseUrl: params.siteBaseUrl,
		bodyHtml,
		footerHtml,
	});

	const text = [
		'Confirm your subscription to the Uprevit Blog',
		'',
		'Click the link below to confirm your email address and receive one short email whenever a new Uprevit blog post goes live. No sales emails, and you can leave any time.',
		'',
		params.confirmUrl,
		'',
		'This link expires in 24 hours. If you did not request this, you can safely ignore this email.',
		...(addressLine ? ['', addressLine] : []),
	].join('\n');

	return { subject, html, text };
};

export const renderBlogPostEmail = (params: {
	post: BlogPostEmailPayload;
	unsubscribeUrl: string;
	siteBaseUrl: string;
	physicalAddress?: string;
}): RenderedNewsletterEmail => {
	const { post } = params;
	const base = params.siteBaseUrl.replace(/\/+$/, '');
	const displayDate = formatDisplayDate(post.date);
	const subject = sanitizeHeader(post.title);
	const addressLine = params.physicalAddress?.trim();
	const excerpt = post.excerpt?.trim();
	const excerptHtml = excerpt
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;"><tr><td style="background-color:#fafafa;border-left:3px solid #7f22fe;border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;line-height:22px;color:#52525b;">${escapeHtml(excerpt)}</td></tr></table>`
		: '';

	const bodyHtml = `
		<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
			<tr>
				<td style="background-color:#f7f2ff;border:1px solid #eee3ff;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;line-height:16px;color:#6a12dc;">${escapeHtml(post.category)}</td>
				<td style="padding-left:10px;font-size:12px;line-height:16px;color:#71717a;">${escapeHtml(post.readTime)}</td>
			</tr>
		</table>
		<h1 style="margin:0 0 14px;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.03em;color:#171717;">
			<a href="${escapeHtml(post.url)}" style="color:#171717;text-decoration:none;">${escapeHtml(post.title)}</a>
		</h1>
		<p style="margin:0 0 ${excerpt ? '18px' : '26px'};font-size:15px;line-height:24px;color:#3f3f46;">${escapeHtml(post.description)}</p>
		${excerptHtml}
		${renderPrimaryButton(post.url, 'Read the full post \u2192')}
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;padding-top:18px;border-top:1px solid #f0f0f2;">
			<tr>
				<td style="font-size:13px;line-height:18px;color:#71717a;">By <span style="color:#171717;font-weight:500;">${escapeHtml(post.author)}</span> &middot; ${escapeHtml(displayDate)}</td>
			</tr>
		</table>
	`;

	const footerHtml = `
		<p style="margin:0;font-size:12px;line-height:18px;color:#71717a;">You&rsquo;re receiving this because you subscribed to Uprevit blog updates. No sales emails.</p>
		<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:#71717a;">
			<a href="${escapeHtml(base)}/resources/blogs" style="color:#52525b;text-decoration:underline;">Browse all posts</a>
			&nbsp;&middot;&nbsp;
			<a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#52525b;text-decoration:underline;">Unsubscribe</a>
		</p>
		${addressLine ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(addressLine)}</p>` : ''}
	`;

	const html = renderShell({
		preheader: post.description,
		headerRight: displayDate,
		siteBaseUrl: params.siteBaseUrl,
		bodyHtml,
		footerHtml,
	});

	const text = [
		`UPREVIT BLOG — ${post.category.toUpperCase()} (${post.readTime})`,
		'',
		post.title,
		'',
		post.description,
		...(excerpt ? ['', excerpt] : []),
		'',
		`Read the full post: ${post.url}`,
		'',
		`By ${post.author} · ${displayDate}`,
		'---',
		'You are receiving this because you subscribed to Uprevit blog updates.',
		`Unsubscribe: ${params.unsubscribeUrl}`,
		...(addressLine ? [addressLine] : []),
	].join('\n');

	return { subject, html, text };
};

export const sendNewsletterEmail = async (params: {
	to: string;
	from: string;
	replyTo?: string;
	configurationSetName?: string;
	email: RenderedNewsletterEmail;
	oneClickUnsubscribeUrl?: string;
}): Promise<void> => {
	const headers: Array<{ Name: string; Value: string }> = [];
	if (params.oneClickUnsubscribeUrl) {
		const safeUrl = sanitizeHeader(params.oneClickUnsubscribeUrl);
		headers.push(
			{ Name: 'List-Unsubscribe', Value: `<${safeUrl}>` },
			{ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
		);
	}

	const replyTo = params.replyTo ? sanitizeHeader(params.replyTo) : undefined;
	const configSet = params.configurationSetName?.trim();

	await sesv2.send(
		new SendEmailCommand({
			FromEmailAddress: sanitizeHeader(params.from),
			Destination: { ToAddresses: [sanitizeHeader(params.to)] },
			...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
			...(configSet ? { ConfigurationSetName: configSet } : {}),
			Content: {
				Simple: {
					Subject: { Data: sanitizeHeader(params.email.subject), Charset: 'UTF-8' },
					Body: {
						Html: { Data: params.email.html, Charset: 'UTF-8' },
						Text: { Data: params.email.text, Charset: 'UTF-8' },
					},
					...(headers.length > 0 ? { Headers: headers } : {}),
				},
			},
		}),
		{ abortSignal: AbortSignal.timeout(SEND_DEADLINE_MS) },
	);
};
