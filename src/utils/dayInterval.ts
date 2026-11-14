const MAX_DAY_MS = 25 * 60 * 60 * 1000;

/**
 * Parses a local calendar day sent as `start/end` ISO instants, so days with a daylight-saving change keep their real length.
 * @param {string} value Interval such as `2026-03-08T05:00:00.000Z/2026-03-09T04:00:00.000Z`
 * @return {[Date, Date] | null} Start and end, or null when the interval is not a single day
 */
export const parseDayInterval = (value: string): [Date, Date] | null => {
	const [start, end, extra] = value.split('/').map((part) => new Date(part));
	if (!start || !end || extra || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
	const length = end.getTime() - start.getTime();
	return length > 0 && length <= MAX_DAY_MS ? [start, end] : null;
};
