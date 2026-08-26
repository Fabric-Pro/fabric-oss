/**
 * Monitoring schedules bootstrap.
 *
 * Idempotently registers the monitoring crons + one synthetic probe
 * schedule per registered provider via the Temporal Schedule API:
 *
 *   - status-page-poller          — every 2 minutes
 *   - synthetic-probe-${provider} — interval from the registry entry
 *   - prune-old-incidents         — daily at 03:00 UTC
 *   - error-rate-weekly-digest    — Monday 09:00 UTC
 *
 * Burn-rate + integration error-rate alerts are evaluated by Azure
 * Application Insights `scheduledQueryRules` / smart detection — no
 * Temporal poller is required to mirror an external alerting backend.
 * App Insights alerts route through the existing Action Group →
 * ALERTS_WEBHOOK_URL → Power Automate flow and are surfaced in-app
 * by writing `IntegrationIncident` / `ErrorRateIncident` rows from
 * the same flow (or its downstream consumer).
 *
 * The synthetic probe set is derived from the integration-provider
 * registry at boot via `getProvidersForSyntheticProbe()` — adding a new
 * probed provider is a one-line registry change in
 * `packages/observability/lib/integration-providers.ts` with no edits
 * to this script.
 *
 * Re-running on worker boot is a no-op for existing schedules.
 *
 * Called from `packages/temporal/src/schedules.ts:registerSystemSchedules()`.
 */
import { getProvidersForSyntheticProbe } from "@repo/observability";
import {
	ScheduleAlreadyRunning,
	type ScheduleClient,
} from "@temporalio/client";

/**
 * Canonical task queue for monitoring workflows.
 *
 * MUST match:
 *   - the worker registration in `packages/temporal/src/worker.ts`
 *     (the `fabricWorker` entry; the `monitoring` alias worker is a
 *     back-compat bridge that consumes the same workflows).
 *   - the per-activity defaults in
 *     `packages/temporal/src/workflows/monitoring/*.ts`.
 *
 * Changing this string requires updating both call sites in lock-step.
 */
const TASK_QUEUE = "fabric-worker";

const SCHEDULES = {
	statusPagePoller: {
		id: "monitoring-status-page-poller",
		workflowType: "statusPagePollerWorkflow",
		cron: "*/2 * * * *", // Every 2 min
		note: "Polls every registered provider's Atlassian Statuspage summary.json every 2 minutes.",
	},
	pruneIncidents: {
		id: "monitoring-prune-old-incidents",
		workflowType: "pruneOldIncidentsWorkflow",
		cron: "0 3 * * *", // 03:00 UTC daily
		note: "Deletes ErrorRateIncident + IntegrationIncident rows older than 365 days nightly.",
	},
	weeklyDigest: {
		id: "monitoring-error-rate-weekly-digest",
		workflowType: "errorRateWeeklyDigestWorkflow",
		cron: "0 9 * * 1", // Monday 09:00 UTC
		note: "Weekly Notification per Fabric admin summarizing the prior week's SEV-3 incidents.",
	},
	statusAnnouncementNotifications: {
		id: "monitoring-status-announcement-notifications",
		workflowType: "statusAnnouncementNotificationWorkflow",
		cron: "*/5 * * * *", // Every 5 min — an outage notice is worthless late
		note: "Notifies organization owners/admins of live MAJOR/CRITICAL platform status announcements. On in every deployed environment; set FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED=false to stop delivery.",
	},
	projectServiceAlertDigest: {
		id: "monitoring-project-service-alert-digest",
		workflowType: "projectServiceAlertDigestWorkflow",
		cron: "0 9 * * 1", // Monday 09:00 UTC
		note: "Weekly Notification per project admin (OWNER/PROJECT_ADMIN) summarizing the prior week's PM-sync failures + conflicts per project.",
	},
} as const;

/**
 * Map an interval string like `"5m"`, `"10m"`, `"1h"` to a cron
 * expression. Only the interval shapes the registry actually uses are
 * supported — adding a new shape requires extending this map. The
 * registry interval defaults to `"5m"` so anything else is opt-in via
 * the per-provider registration.
 */
function intervalToCron(interval: string): string {
	switch (interval) {
		case "1m":
			return "* * * * *";
		case "2m":
			return "*/2 * * * *";
		case "5m":
			return "*/5 * * * *";
		case "10m":
			return "*/10 * * * *";
		case "15m":
			return "*/15 * * * *";
		case "30m":
			return "*/30 * * * *";
		case "1h":
			return "0 * * * *";
		default:
			// Unknown intervals fall back to 5 minutes — same as the
			// historic default. The operator sees the log line and can
			// add a new map entry if needed.
			console.warn(
				`[Worker] Unknown probe interval "${interval}"; falling back to */5 * * * *`,
			);
			return "*/5 * * * *";
	}
}

export async function ensureMonitoringSchedules(
	scheduleClient: ScheduleClient,
): Promise<void> {
	await registerStatusPagePollerSchedule(scheduleClient);
	// Drive synthetic-probe schedules from the registry — adding a new
	// probed provider only requires a registry entry, no edits here.
	for (const provider of getProvidersForSyntheticProbe()) {
		await registerSyntheticProbeSchedule(
			scheduleClient,
			provider.key,
			provider.syntheticProbe?.interval ?? "5m",
		);
	}
	await registerPruneIncidentsSchedule(scheduleClient);
	await registerWeeklyDigestSchedule(scheduleClient);
	await registerProjectServiceAlertDigestSchedule(scheduleClient);
	await registerStatusAnnouncementNotificationSchedule(scheduleClient);
}

async function registerStatusPagePollerSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCHEDULES.statusPagePoller;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "5 minutes",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (every 2 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerSyntheticProbeSchedule(
	scheduleClient: ScheduleClient,
	providerKey: string,
	interval: string,
): Promise<void> {
	const scheduleId = `monitoring-synthetic-probe-${providerKey}`;
	const cron = intervalToCron(interval);
	try {
		await scheduleClient.create({
			scheduleId,
			spec: { cronExpressions: [cron] },
			action: {
				type: "startWorkflow",
				workflowType: "syntheticProbeWorkflow",
				taskQueue: TASK_QUEUE,
				args: [{ providerKey }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "10 minutes",
			},
			state: {
				paused: false,
				note: `Synthetic probe for ${providerKey} — runs every ${interval}.`,
			},
		});
		console.log(
			`[Worker] Schedule "${scheduleId}" registered (every ${interval})`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${scheduleId}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerPruneIncidentsSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCHEDULES.pruneIncidents;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{ olderThanDays: 365 }],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (daily 03:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerWeeklyDigestSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCHEDULES.weeklyDigest;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 day",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (Mondays 09:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

async function registerProjectServiceAlertDigestSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCHEDULES.projectServiceAlertDigest;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 day",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (Mondays 09:00 UTC)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}

/**
 * The push half of the customer status page.
 *
 * Registered unconditionally, and inert until an operator sets
 * `FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED=true`: the activity returns
 * `skipped` without querying anything. The schedule exists so that turning the flag
 * on is the ONLY step needed — a flag whose workflow was never scheduled looks
 * enabled and does nothing.
 *
 * Runs every 5 minutes rather than fanning out at publish time. Publish-time fan-out
 * would scale with tenant count inside one admin request, and a retry would re-send
 * something that cannot be recalled. Re-ticking is cheap: the sweeper checks which
 * rows already exist before writing, so a repeat tick costs one indexed lookup per
 * organization page rather than a write attempt per recipient.
 *
 * It deliberately does NOT rely on the partial unique index for that, which an
 * earlier version of this comment claimed. That index is
 * `WHERE readAt IS NULL AND archivedAt IS NULL`, so it stops constraining a row once
 * the recipient opens the bell — fine for an event-driven writer, wrong for a sweeper
 * that re-attempts the same write every five minutes. The index remains as a race
 * guard.
 */
async function registerStatusAnnouncementNotificationSchedule(
	scheduleClient: ScheduleClient,
): Promise<void> {
	const config = SCHEDULES.statusAnnouncementNotifications;
	try {
		await scheduleClient.create({
			scheduleId: config.id,
			spec: { cronExpressions: [config.cron] },
			action: {
				type: "startWorkflow",
				workflowType: config.workflowType,
				taskQueue: TASK_QUEUE,
				args: [{}],
			},
			policies: {
				overlap: "SKIP",
				catchupWindow: "1 day",
			},
			state: { paused: false, note: config.note },
		});
		console.log(
			`[Worker] Schedule "${config.id}" registered (every 5 minutes)`,
		);
	} catch (error) {
		if (error instanceof ScheduleAlreadyRunning) {
			console.log(
				`[Worker] Schedule "${config.id}" already exists, skipping`,
			);
		} else {
			throw error;
		}
	}
}
