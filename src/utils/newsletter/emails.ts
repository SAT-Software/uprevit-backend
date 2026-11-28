import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const SEND_DEADLINE_MS = 8000;
const DEFAULT_ASSET_BASE_URL = 'https://dncq73ywgnkr9.cloudfront.net';

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
	highlights?: string[];
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

const getEmailAssetBaseUrl = (): string =>
	(process.env.NEWSLETTER_ASSET_BASE_URL?.trim() || DEFAULT_ASSET_BASE_URL).replace(/\/+$/, '');

const EMAIL_STYLES = `
	:root { color-scheme: light dark; supported-color-schemes: light dark; }
	.logo-dark { display: none !important; max-height: 0 !important; overflow: hidden !important; mso-hide: all !important; }
	@media only screen and (max-width: 600px) {
		.outer-pad { padding: 20px 12px !important; }
		.card-pad { padding: 24px 20px !important; }
		.email-h1 { font-size: 21px !important; line-height: 28px !important; }
		.email-lead { font-size: 14px !important; line-height: 22px !important; }
		.cta-table { width: 100% !important; }
		.cta-link { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
		.header-date { display: none !important; }
	}
	@media (prefers-color-scheme: dark) {
		body, .email-bg { background-color: #0f0f10 !important; color: #ededed !important; }
		.email-card { background-color: #171718 !important; border-color: #27272a !important; }
		.logo-light { display: none !important; max-height: 0 !important; overflow: hidden !important; }
		.logo-dark { display: block !important; max-height: none !important; overflow: visible !important; }
		.text-ink, .text-ink a { color: #f4f4f5 !important; }
		.text-body { color: #a1a1aa !important; }
		.text-muted, .text-muted a { color: #8b8b93 !important; }
		.text-faint, .text-faint a { color: #71717a !important; }
		.badge-neutral { background-color: #262629 !important; border-color: #36363b !important; color: #ededed !important; }
		.callout-box { background-color: #1e1e21 !important; border-color: #2c2c30 !important; }
		.callout-title { color: #d4d4d8 !important; }
		.callout-item { color: #a1a1aa !important; }
		.callout-dot { color: #71717a !important; }
		.hairline { border-color: #27272a !important; }
		.v-divider { background-color: #36363b !important; }
	}
	[data-ogsc] .email-bg { background-color: #0f0f10 !important; }
	[data-ogsc] .email-card { background-color: #171718 !important; border-color: #27272a !important; }
	[data-ogsc] .logo-light { display: none !important; }
	[data-ogsc] .logo-dark { display: block !important; max-height: none !important; overflow: visible !important; }
	[data-ogsc] .text-ink, [data-ogsc] .text-ink a { color: #f4f4f5 !important; }
	[data-ogsc] .text-body { color: #a1a1aa !important; }
	[data-ogsc] .text-muted, [data-ogsc] .text-muted a { color: #8b8b93 !important; }
	[data-ogsc] .badge-neutral { background-color: #262629 !important; border-color: #36363b !important; color: #ededed !important; }
	[data-ogsc] .callout-box { background-color: #1e1e21 !important; border-color: #2c2c30 !important; }
	[data-ogsc] .hairline { border-color: #27272a !important; }
`;

const renderShell = (params: {
	preheader: string;
	headerRight?: string;
	siteBaseUrl: string;
	bodyHtml: string;
	footerHtml: string;
}): string => {
	const base = params.siteBaseUrl.replace(/\/+$/, '');
	const assetBase = getEmailAssetBaseUrl();
	const logoLightUrl = `${assetBase}/email/uprevit-logo-light.png`;
	const logoDarkUrl = `${assetBase}/email/uprevit-logo-dark.png`;
	const headerRightCell = params.headerRight
		? `<td class="header-date text-muted" align="right" valign="middle" style="font-size:12px;line-height:16px;color:#71717a;white-space:nowrap;">${escapeHtml(params.headerRight)}</td>`
		: '';

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<meta name="x-apple-disable-message-reformatting" />
	<meta name="color-scheme" content="light dark" />
	<meta name="supported-color-schemes" content="light dark" />
	<title>Uprevit Blog</title>
	<style>${EMAIL_STYLES}</style>
</head>
<body class="email-bg" style="margin:0;padding:0;background-color:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;-webkit-font-smoothing:antialiased;">
	<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(params.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
	<table role="presentation" class="email-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f6f6;">
		<tr>
			<td class="outer-pad" align="center" style="padding:36px 16px;">
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
					<tr>
						<td style="padding:0 4px 18px;">
							<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
								<tr>
									<td valign="middle">
										<a href="${escapeHtml(base)}/resources/blogs" style="text-decoration:none;color:#171717;">
											<table role="presentation" cellpadding="0" cellspacing="0" border="0">
												<tr>
													<td valign="middle">
														<img class="logo-light" src="${escapeHtml(logoLightUrl)}" alt="Uprevit" width="108" height="28" style="display:block;border:0;outline:none;text-decoration:none;height:28px;width:auto;" />
														<img class="logo-dark" src="${escapeHtml(logoDarkUrl)}" alt="Uprevit" width="108" height="28" style="display:none;max-height:0;overflow:hidden;border:0;outline:none;text-decoration:none;height:28px;width:auto;" />
													</td>
													<td valign="middle" style="padding:0 10px;">
														<span class="v-divider" style="display:block;width:1px;height:14px;background-color:#d4d4d8;"></span>
													</td>
													<td valign="middle">
														<span class="text-muted" style="font-size:13px;font-weight:500;line-height:18px;color:#71717a;">Blog</span>
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
						<td class="email-card card-pad" style="background-color:#ffffff;border:1px solid #e5e5e5;border-radius:14px;padding:32px 32px 30px;">
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

const renderNeutralBadge = (label: string): string =>
	`<span class="badge-neutral" style="display:inline-block;background-color:#f6f6f6;border:1px solid #e5e5e5;border-radius:5px;padding:3px 9px;font-size:12px;font-weight:500;line-height:16px;color:#171717;">${escapeHtml(label)}</span>`;

const renderPrimaryButton = (href: string, label: string): string =>
	`<table role="presentation" class="cta-table" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
		<tr>
			<td align="center" bgcolor="#7f22fe" style="border-radius:8px;background-color:#7f22fe;border:1px solid #6a12dc;">
				<a class="cta-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:18px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
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
		<div style="margin:0 0 16px;">${renderNeutralBadge('One quick step')}</div>
		<h1 class="email-h1 text-ink" style="margin:0 0 12px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-0.025em;color:#171717;">Confirm your blog subscription</h1>
		<p class="email-lead text-body" style="margin:0 0 24px;font-size:15px;line-height:24px;color:#52525b;">Click below to verify your email address. We&rsquo;ll send one short note whenever a new post goes live&mdash;practical guides on medical device labeling, FDA QMSR, EU MDR, and more, along with occasional Uprevit product updates. No sales emails, and you can leave any time.</p>
		${renderPrimaryButton(params.confirmUrl, 'Confirm subscription')}
		<p class="hairline text-muted" style="margin:24px 0 0;padding-top:20px;border-top:1px solid #ececee;font-size:13px;line-height:20px;color:#71717a;">This confirmation link expires in 72 hours. If you didn&rsquo;t ask to subscribe, you can safely ignore this email.</p>
		<p class="text-faint" style="margin:10px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;word-break:break-all;">Or copy this link: <a href="${escapeHtml(params.confirmUrl)}" style="color:#71717a;text-decoration:underline;">${escapeHtml(params.confirmUrl)}</a></p>
	`;

	const footerHtml = `
		<p class="text-muted" style="margin:0;font-size:12px;line-height:18px;color:#71717a;">Sent by Uprevit &middot; <a href="${escapeHtml(params.siteBaseUrl.replace(/\/+$/, ''))}" style="color:#71717a;text-decoration:underline;">uprevit.com</a></p>
		${addressLine ? `<p class="text-faint" style="margin:6px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(addressLine)}</p>` : ''}
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
		'Click the link below to verify your email address. We will send one short email whenever a new post goes live — practical guides on medical device labeling, FDA QMSR, EU MDR, and more, along with occasional Uprevit product updates. No sales emails, and you can leave any time.',
		'',
		params.confirmUrl,
		'',
		'This link expires in 72 hours. If you did not request this, you can safely ignore this email.',
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

	const highlights = (post.highlights ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 5);
	const excerpt = post.excerpt?.trim();

	let calloutHtml = '';
	if (highlights.length > 0) {
		const rows = highlights
			.map(
				(item) =>
					`<tr><td class="callout-dot" valign="top" width="14" style="padding:3px 8px 3px 0;font-size:13px;line-height:20px;color:#a1a1aa;">&bull;</td><td class="callout-item" style="padding:3px 0;font-size:14px;line-height:20px;color:#3f3f46;">${escapeHtml(item)}</td></tr>`,
			)
			.join('');
		calloutHtml = `<table role="presentation" class="callout-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;background-color:#fafafa;border:1px solid #e5e5e5;border-radius:10px;"><tr><td style="padding:16px 18px;"><p class="callout-title" style="margin:0 0 8px;font-size:12px;font-weight:600;line-height:16px;color:#52525b;">In this post</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`;
	} else if (excerpt) {
		calloutHtml = `<table role="presentation" class="callout-box" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;background-color:#fafafa;border:1px solid #e5e5e5;border-radius:10px;"><tr><td class="callout-item" style="padding:14px 16px;font-size:14px;line-height:22px;color:#52525b;">${escapeHtml(excerpt)}</td></tr></table>`;
	}

	const bodyHtml = `
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
			<tr>
				<td valign="middle">${renderNeutralBadge(post.category)}</td>
				<td class="text-muted" align="right" valign="middle" style="font-size:13px;line-height:18px;color:#71717a;white-space:nowrap;">${escapeHtml(displayDate)}</td>
			</tr>
		</table>
		<h1 class="email-h1 text-ink" style="margin:0 0 14px;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.03em;color:#171717;">
			<a href="${escapeHtml(post.url)}" style="color:#171717;text-decoration:none;">${escapeHtml(post.title)}</a>
		</h1>
		<p class="email-lead text-body" style="margin:0 0 ${calloutHtml ? '20px' : '26px'};font-size:15px;line-height:24px;color:#52525b;">${escapeHtml(post.description)}</p>
		${calloutHtml}
		${renderPrimaryButton(post.url, 'Read the full post \u2192')}
		<table role="presentation" class="hairline" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;padding-top:18px;border-top:1px solid #ececee;">
			<tr>
				<td class="text-muted" style="font-size:13px;line-height:18px;color:#71717a;">By <span class="text-ink" style="color:#171717;font-weight:500;">${escapeHtml(post.author)}</span></td>
			</tr>
			<tr>
				<td class="text-faint" style="padding-top:2px;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(post.readTime)}</td>
			</tr>
		</table>
	`;

	const footerHtml = `
		<p class="text-muted" style="margin:0;font-size:12px;line-height:18px;color:#71717a;">You&rsquo;re receiving this because you subscribed to Uprevit blog updates. No sales emails.</p>
		<p class="text-muted" style="margin:8px 0 0;font-size:12px;line-height:18px;color:#71717a;">
			<a href="${escapeHtml(base)}/resources/blogs" style="color:#52525b;text-decoration:underline;">Browse all posts</a>
			&nbsp;&middot;&nbsp;
			<a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#52525b;text-decoration:underline;">Unsubscribe</a>
		</p>
		${addressLine ? `<p class="text-faint" style="margin:8px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(addressLine)}</p>` : ''}
	`;

	const html = renderShell({
		preheader: post.description,
		siteBaseUrl: params.siteBaseUrl,
		bodyHtml,
		footerHtml,
	});

	const highlightsText = highlights.length > 0 ? ['In this post:', ...highlights.map((h) => `- ${h}`)].join('\n') : undefined;
	const text = [
		`UPREVIT BLOG — ${post.category} (${displayDate} · ${post.readTime})`,
		'',
		post.title,
		'',
		post.description,
		...(highlightsText ? ['', highlightsText] : excerpt ? ['', excerpt] : []),
		'',
		`Read the full post: ${post.url}`,
		'',
		`By ${post.author}`,
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
