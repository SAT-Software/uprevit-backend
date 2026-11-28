import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logError, logInfo, logWarn } from '../../utils/logger';
import { bumpRateLimit, getSubscriber, upsertPendingSubscriber } from '../../utils/newsletter/db';
import { renderConfirmSubscriptionEmail, sendNewsletterEmail } from '../../utils/newsletter/emails';
import {
	getClientIp,
	getNewsletterFromAddress,
	getNewsletterPhysicalAddress,
	getNewsletterReplyToAddress,
	getNewsletterSiteBaseUrl,
	hashRateLimitKey,
	isNewsletterOriginAllowed,
	normalizeAndValidateEmail,
	parseJsonBody,
	rateLimitedResponse,
	verifyNewsletterTurnstile,
} from '../../utils/newsletter/request';
import { createConfirmToken, getNewsletterTokenSecret } from '../../utils/newsletter/tokens';
import { ResponseWrapper } from '../../utils/responseWrapper';
import { withTelemetry } from '../../utils/telemetry';

const IP_LIMIT = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_SHORT_LIMIT = 2;
const EMAIL_SHORT_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_DAILY_LIMIT = 3;
const EMAIL_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TTL_BUFFER_SEC = 60;

const GENERIC_SUCCESS_MESSAGE = 'Check your inbox to confirm your subscription.';

export const lambdaHandler = withTelemetry(async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
	try {
		if (!isNewsletterOriginAllowed(event)) {
			return ResponseWrapper.forbidden('Origin not allowed.');
		}

		const parsed = parseJsonBody(event);
		if (!parsed.ok) return parsed.response;

		const honeypot = parsed.data.website;
		if (typeof honeypot === 'string' && honeypot.trim().length > 0) {
			logWarn('Newsletter subscribe honeypot triggered');
			return ResponseWrapper.success({ message: GENERIC_SUCCESS_MESSAGE });
		}

		const emailResult = normalizeAndValidateEmail(parsed.data.email);
		if (!emailResult.ok) {
			return ResponseWrapper.badRequest(emailResult.message, { errors: { email: emailResult.message } });
		}

		const rawToken = parsed.data.turnstileToken;
		const turnstileToken = typeof rawToken === 'string' ? rawToken.trim() : '';
		if ((rawToken !== undefined && rawToken !== null && typeof rawToken !== 'string') || turnstileToken.length > 4096) {
			return ResponseWrapper.badRequest('Invalid verification token.');
		}

		const nowMs = Date.now();
		const ipBucket = Math.floor(nowMs / IP_WINDOW_MS);
		const ipResetsAtMs = (ipBucket + 1) * IP_WINDOW_MS;
		const ipExpiresAtSec = Math.ceil(ipResetsAtMs / 1000) + TTL_BUFFER_SEC;

		const emailShortBucket = Math.floor(nowMs / EMAIL_SHORT_WINDOW_MS);
		const emailShortResetsAtMs = (emailShortBucket + 1) * EMAIL_SHORT_WINDOW_MS;
		const emailShortExpiresAtSec = Math.ceil(emailShortResetsAtMs / 1000) + TTL_BUFFER_SEC;

		const emailDailyBucket = Math.floor(nowMs / EMAIL_DAILY_WINDOW_MS);
		const emailDailyResetsAtMs = (emailDailyBucket + 1) * EMAIL_DAILY_WINDOW_MS;
		const emailDailyExpiresAtSec = Math.ceil(emailDailyResetsAtMs / 1000) + TTL_BUFFER_SEC;

		const clientIp = getClientIp(event);
		const ipKey = `sub:ip:${hashRateLimitKey(clientIp)}:${ipBucket}`;
		const ipCount = await bumpRateLimit(ipKey, 1, ipExpiresAtSec);
		if (ipCount > IP_LIMIT) {
			await bumpRateLimit(ipKey, -1, ipExpiresAtSec).catch(() => undefined);
			return rateLimitedResponse(ipResetsAtMs);
		}

		const verification = await verifyNewsletterTurnstile(turnstileToken, clientIp).catch(async (error) => {
			await bumpRateLimit(ipKey, -1, ipExpiresAtSec).catch(() => undefined);
			throw error;
		});

		if (!verification.ok) {
			if (verification.status !== 'failed') {
				await bumpRateLimit(ipKey, -1, ipExpiresAtSec).catch(() => undefined);
			}
			if (verification.status === 'missing') {
				return ResponseWrapper.badRequest('Please complete the verification check and try again.');
			}
			if (verification.status === 'failed') {
				return ResponseWrapper.forbidden('Verification failed. Please refresh and try again.');
			}
			return ResponseWrapper.internalServerError('Verification service is temporarily unavailable. Please try again.');
		}

		const emailHash = hashRateLimitKey(emailResult.normalizedEmail);
		const emailShortKey = `sub:email15m:${emailHash}:${emailShortBucket}`;
		const emailDailyKey = `sub:email24h:${emailHash}:${emailDailyBucket}`;

		const rollbackIp = () => bumpRateLimit(ipKey, -1, ipExpiresAtSec).catch(() => undefined);
		const rollbackShort = () => bumpRateLimit(emailShortKey, -1, emailShortExpiresAtSec).catch(() => undefined);
		const rollbackDaily = () => bumpRateLimit(emailDailyKey, -1, emailDailyExpiresAtSec).catch(() => undefined);

		const emailShortCount = await bumpRateLimit(emailShortKey, 1, emailShortExpiresAtSec).catch(async (error) => {
			await rollbackIp();
			throw error;
		});
		if (emailShortCount > EMAIL_SHORT_LIMIT) {
			await rollbackShort();
			await rollbackIp();
			return rateLimitedResponse(emailShortResetsAtMs);
		}

		const emailDailyCount = await bumpRateLimit(emailDailyKey, 1, emailDailyExpiresAtSec).catch(async (error) => {
			await rollbackShort();
			await rollbackIp();
			throw error;
		});
		if (emailDailyCount > EMAIL_DAILY_LIMIT) {
			await rollbackDaily();
			await rollbackShort();
			await rollbackIp();
			return rateLimitedResponse(emailDailyResetsAtMs);
		}

		const existing = await getSubscriber(emailResult.normalizedEmail);
		if (existing && (existing.status === 'subscribed' || existing.status === 'bounced' || existing.status === 'complained')) {
			logInfo('Newsletter subscribe skipped for existing non-subscribable status', { status: existing.status });
			return ResponseWrapper.success({ message: GENERIC_SUCCESS_MESSAGE });
		}

		const secret = await getNewsletterTokenSecret();
		if (!secret) {
			await Promise.all([rollbackDaily(), rollbackShort(), rollbackIp()]);
			logError('Newsletter token secret is not configured', new Error('Missing newsletter token secret'));
			return ResponseWrapper.internalServerError('Unable to process subscription right now. Please try again later.');
		}

		const { token, tokenHash, expiresAt } = createConfirmToken(emailResult.normalizedEmail, secret, nowMs);
		const nowIso = new Date(nowMs).toISOString();
		const siteBaseUrl = getNewsletterSiteBaseUrl(event);
		const confirmUrl = `${siteBaseUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`;

		try {
			const updated = await upsertPendingSubscriber({
				email: emailResult.normalizedEmail,
				confirmTokenHash: tokenHash,
				confirmTokenExpiresAt: expiresAt,
				nowIso,
				source: typeof parsed.data.source === 'string' ? parsed.data.source.trim().slice(0, 60) || 'blog' : 'blog',
			});

			if (!updated) {
				logInfo('Newsletter subscribe skipped due to concurrent subscriber status transition');
				return ResponseWrapper.success({ message: GENERIC_SUCCESS_MESSAGE });
			}

			const rendered = renderConfirmSubscriptionEmail({
				confirmUrl,
				siteBaseUrl,
				physicalAddress: getNewsletterPhysicalAddress(),
			});

			await sendNewsletterEmail({
				to: emailResult.normalizedEmail,
				from: getNewsletterFromAddress(),
				replyTo: getNewsletterReplyToAddress(),
				configurationSetName: process.env.NEWSLETTER_CONFIGURATION_SET,
				email: rendered,
			});
		} catch (error) {
			await Promise.all([rollbackDaily(), rollbackShort(), rollbackIp()]);
			logError('Failed to send newsletter confirmation email', error);
			return ResponseWrapper.internalServerError('Unable to send confirmation email right now. Please try again later.');
		}

		return ResponseWrapper.success({ message: GENERIC_SUCCESS_MESSAGE });
	} catch (error) {
		logError('Failed to process newsletter subscription', error);
		return ResponseWrapper.internalServerError('Unable to process subscription right now. Please try again later.');
	}
});
