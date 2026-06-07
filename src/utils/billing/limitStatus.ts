import type { LimitStatus, UsageLimits } from '../../models/billing';

const buildMetricStatus = (used: number, limit: number) => {
	const delta = Math.max(0, used - limit);
	return {
		used,
		limit,
		delta,
		overLimit: delta > 0,
	};
};

export const buildLimitStatus = ({
	activeSeats,
	exports,
	uploadGb,
	usageLimits,
}: {
	activeSeats: number;
	exports: number;
	uploadGb: number;
	usageLimits: UsageLimits;
}): LimitStatus => ({
	seats: buildMetricStatus(activeSeats, usageLimits.seats),
	exports: buildMetricStatus(exports, usageLimits.exports),
	uploadGb: buildMetricStatus(uploadGb, usageLimits.uploadGb),
});
