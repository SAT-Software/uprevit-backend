const parseChargebeeItemPriceIds = (...sources: Array<string | undefined>): string[] => {
	const ids = new Set<string>();
	for (const source of sources) {
		if (!source?.trim()) continue;
		for (const part of source.split(',')) {
			const trimmed = part.trim();
			if (trimmed) ids.add(trimmed);
		}
	}
	return [...ids];
};

export const getChargebeeSite = (): string => process.env.CHARGEBEE_SITE?.trim() ?? '';

export const getChargebeeApiKey = (): string => process.env.CHARGEBEE_API_KEY?.trim() ?? '';

export const getChargebeeWebhookUsername = (): string =>
	process.env.CHARGEBEE_WEBHOOK_USERNAME?.trim() ?? '';

export const getChargebeeWebhookPassword = (): string =>
	process.env.CHARGEBEE_WEBHOOK_PASSWORD?.trim() ?? '';

/** All configured seat add-on item price IDs (monthly, yearly, and legacy single/comma-separated). */
export const getChargebeeSeatAddonItemPriceIds = (): string[] =>
	parseChargebeeItemPriceIds(
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID,
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_MONTHLY,
		process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID_YEARLY,
	);

/** All configured SSO add-on item price IDs (monthly, yearly, and legacy single/comma-separated). */
export const getChargebeeSsoAddonItemPriceIds = (): string[] =>
	parseChargebeeItemPriceIds(
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID,
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_MONTHLY,
		process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID_YEARLY,
	);

/** @deprecated Prefer getChargebeeSeatAddonItemPriceIds for multi-cadence matching. */
export const getChargebeeSeatAddonItemPriceId = (): string =>
	getChargebeeSeatAddonItemPriceIds()[0] ?? '';

/** @deprecated Prefer getChargebeeSsoAddonItemPriceIds for multi-cadence matching. */
export const getChargebeeSsoAddonItemPriceId = (): string =>
	getChargebeeSsoAddonItemPriceIds()[0] ?? '';

export const isChargebeeConfigured = (): boolean =>
	Boolean(getChargebeeSite() && getChargebeeApiKey());

export const isChargebeeWebhookConfigured = (): boolean =>
	Boolean(getChargebeeWebhookUsername() && getChargebeeWebhookPassword());
