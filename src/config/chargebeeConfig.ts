export const getChargebeeSite = (): string => process.env.CHARGEBEE_SITE?.trim() ?? '';

export const getChargebeeApiKey = (): string => process.env.CHARGEBEE_API_KEY?.trim() ?? '';

export const getChargebeeWebhookUsername = (): string =>
	process.env.CHARGEBEE_WEBHOOK_USERNAME?.trim() ?? '';

export const getChargebeeWebhookPassword = (): string =>
	process.env.CHARGEBEE_WEBHOOK_PASSWORD?.trim() ?? '';

export const getChargebeeSeatAddonItemPriceId = (): string =>
	process.env.CHARGEBEE_SEAT_ADDON_ITEM_PRICE_ID?.trim() ?? '';

export const getChargebeeSsoAddonItemPriceId = (): string =>
	process.env.CHARGEBEE_SSO_ADDON_ITEM_PRICE_ID?.trim() ?? '';

export const isChargebeeConfigured = (): boolean =>
	Boolean(getChargebeeSite() && getChargebeeApiKey());

export const isChargebeeWebhookConfigured = (): boolean =>
	Boolean(getChargebeeWebhookUsername() && getChargebeeWebhookPassword());
