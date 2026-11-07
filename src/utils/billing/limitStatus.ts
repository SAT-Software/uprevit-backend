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
	activeApproverSeats,
	exports,
	uploadGb,
	usageLimits,
}: {
	activeSeats: number;
	activeApproverSeats: number;
	exports: number;
	uploadGb: number;
	usageLimits: UsageLimits;
}): LimitStatus => ({
	seats: buildMetricStatus(activeSeats, usageLimits.seats),
	approverSeats: buildMetricStatus(activeApproverSeats, usageLimits.approverSeats),
	exports: buildMetricStatus(exports, usageLimits.exports),
	uploadGb: buildMetricStatus(uploadGb, usageLimits.uploadGb),
});
