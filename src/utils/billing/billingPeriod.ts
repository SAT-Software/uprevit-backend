import type { BillingAccount, BillingCadence } from '../../models/billing';

const BYTES_PER_GB = 1024 * 1024 * 1024;

export const bytesToGb = (bytes: number): number => bytes / BYTES_PER_GB;

export const gbToBytes = (gb: number): number => gb * BYTES_PER_GB;

export const addUtcMonths = (date: Date, months: number): Date => {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();

	return new Date(Date.UTC(
		year,
		month + months,
		day,
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds(),
	));
};

const cadenceMonths = (cadence: BillingCadence): number => (cadence === 'yearly' ? 12 : 1);

export const endOfBillingPeriod = (periodStart: Date, cadence: BillingCadence): Date => {
	const nextPeriodStart = addUtcMonths(periodStart, cadenceMonths(cadence));
	return new Date(nextPeriodStart.getTime() - 1);
};

export const computeBillingPeriodFromAnchor = (
	anchor: Date,
	cadence: BillingCadence,
	now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } => {
	let periodStart = new Date(anchor);
	let periodEnd = endOfBillingPeriod(periodStart, cadence);

	while (now.getTime() > periodEnd.getTime()) {
		periodStart = addUtcMonths(periodStart, cadenceMonths(cadence));
		periodEnd = endOfBillingPeriod(periodStart, cadence);
	}

	return { periodStart, periodEnd };
};

export const resolveBillingPeriod = (
	account: Pick<BillingAccount, 'billingCadence' | 'periodStart' | 'periodEnd' | 'createdAt'>,
	now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } => {
	const anchor = account.periodStart ?? account.createdAt;
	return computeBillingPeriodFromAnchor(anchor, account.billingCadence, now);
};

export const calendarMonthKey = (date: Date): string =>
	`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

export const defaultPeriodForCadence = (
	cadence: BillingCadence,
	now: Date = new Date(),
): { periodStart: Date; periodEnd: Date } => {
	const periodStart = now;
	const periodEnd = endOfBillingPeriod(periodStart, cadence);
	return { periodStart, periodEnd };
};
