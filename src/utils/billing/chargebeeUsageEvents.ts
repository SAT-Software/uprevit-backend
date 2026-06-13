import { getChargebeeApiKey, getChargebeeSite, isChargebeeConfigured } from '../../config/chargebeeConfig';

export { isChargebeeConfigured };

const BYTES_PER_MB = 1024 * 1024;

export const bytesToUploadMb = (bytes: number): number => Math.ceil(bytes / BYTES_PER_MB);

export const ingestUsageEvent = async ({
	subscriptionId,
	deduplicationId,
	usageTimestamp,
	properties,
}: {
	subscriptionId: string;
	deduplicationId: string;
	usageTimestamp: Date;
	properties: Record<string, number>;
}): Promise<void> => {
	if (!isChargebeeConfigured()) {
		throw new Error('Chargebee is not configured');
	}

	const site = getChargebeeSite();
	const apiKey = getChargebeeApiKey();

	const response = await fetch(`https://${site}.ingest.chargebee.com/api/v2/usage_events`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			deduplication_id: deduplicationId,
			subscription_id: subscriptionId,
			usage_timestamp: usageTimestamp.getTime(),
			properties,
		}),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(body || `Chargebee usage event ingest failed (${response.status})`);
	}
};

export const ingestExportUsageEvent = async ({
	subscriptionId,
	deduplicationId,
	usageTimestamp,
	quantity = 1,
}: {
	subscriptionId: string;
	deduplicationId: string;
	usageTimestamp: Date;
	quantity?: number;
}): Promise<void> => {
	await ingestUsageEvent({
		subscriptionId,
		deduplicationId,
		usageTimestamp,
		properties: { exports: quantity },
	});
};

export const ingestUploadUsageEvent = async ({
	subscriptionId,
	deduplicationId,
	usageTimestamp,
	uploadBytes,
}: {
	subscriptionId: string;
	deduplicationId: string;
	usageTimestamp: Date;
	uploadBytes: number;
}): Promise<void> => {
	await ingestUsageEvent({
		subscriptionId,
		deduplicationId,
		usageTimestamp,
		properties: { upload_mb: bytesToUploadMb(uploadBytes) },
	});
};
