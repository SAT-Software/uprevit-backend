const { MONITORING_STACK } = process.env;

export type MonitoringMetric = 'ExportJobFailed' | 'UsageEventSyncFailed' | 'UsageEventManualCorrectionRequired';

/**
 * Emits a CloudWatch count metric through Embedded Metric Format; no-op when monitoring is disabled.
 * @param {MonitoringMetric} name Metric name
 * @param {number} value Count to record
 */
export function emitMonitoringMetric(name: MonitoringMetric, value: number = 1): void {
	if (!MONITORING_STACK || value <= 0) return;

	process.stdout.write(`${JSON.stringify({
		_aws: {
			Timestamp: Date.now(),
			CloudWatchMetrics: [{
				Namespace: 'Uprevit',
				Dimensions: [['Stack']],
				Metrics: [{ Name: name, Unit: 'Count' }],
			}],
		},
		Stack: MONITORING_STACK,
		[name]: value,
	})}\n`);
}
