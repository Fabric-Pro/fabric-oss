/**
 * statusPagePollerWorkflow.
 *
 * Cron-via-continueAsNew shape. Every 2 minutes, fan out an
 * `pollStatusPage` activity per registered provider that has Statuspage
 * polling enabled. For each result:
 *   - `openIncident !== null` → upsert IntegrationIncident + start
 *     incidentLifecycleWorkflow (signal-driven, one-per-incident).
 *   - `shouldCloseExisting === true` AND the provider is currently
 *     active in our DB → call closeIntegrationIncident with the
 *     2-consecutive-operational-polls hysteresis (L14).
 *
 * Per-provider try/catch — one provider's failure must not block the
 * iteration. We log + continue.
 *
 * `continueAsNew` every 720 iterations (~24h of 2-minute ticks) bounds
 * the workflow history. Schedules created via the Schedule API spawn
 * one workflow per fire; the workflow's own `continueAsNew` is a
 * defense-in-depth against the unlikely case of the Schedule failing
 * to spawn.
 */
import {
	continueAsNew,
	log,
	proxyActivities,
	sleep,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";
import {
	type IncidentLifecycleInput,
	incidentLifecycleWorkflow,
} from "./incident-lifecycle";

const { pollStatusPage, listProviderRegistry } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "60s",
	retry: { initialInterval: "5s", maximumAttempts: 3 },
});

const { upsertIntegrationIncident, closeIntegrationIncident } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	retry: { initialInterval: "2s", maximumAttempts: 3 },
});

export interface StatusPagePollerInput {
	/**
	 * Iteration counter — used to trigger continueAsNew every MAX_ITER
	 * iterations. Defaulted to 0 on first start.
	 */
	iteration?: number;
	/**
	 * Map of providerKey → consecutive-operational-poll count. Used to
	 * implement the "2 consecutive operational polls" hysteresis (L14)
	 * for STATUSPAGE_POLL closures. Reset to 0 when health flips to
	 * non-OPERATIONAL.
	 */
	operationalPolls?: Record<string, number>;
}

const MAX_ITER = 720; // ~24h of 2-minute ticks
const OPERATIONAL_HYSTERESIS = 2; // L14: close after 2 consecutive operational polls

export async function statusPagePollerWorkflow(
	input: StatusPagePollerInput = {},
): Promise<void> {
	const iteration = input.iteration ?? 0;
	const operationalPolls = { ...(input.operationalPolls ?? {}) };

	let providers: Awaited<ReturnType<typeof listProviderRegistry>>;
	try {
		providers = await listProviderRegistry({ filter: "polling" });
	} catch (error) {
		log.warn("Failed to list provider registry", {
			error: error instanceof Error ? error.message : String(error),
		});
		providers = [];
	}

	for (const provider of providers) {
		if (!provider.statusPageApiUrl) {
			continue;
		}

		try {
			const result = await pollStatusPage({
				providerKey: provider.key,
				url: provider.statusPageApiUrl,
				customParser: provider.customParser,
				googleWorkspaceServiceName: provider.googleWorkspaceServiceName,
				googleCloudProductTitle: provider.googleCloudProductTitle,
				zendeskServiceSlug: provider.zendeskServiceSlug,
				statusPageComponents: provider.statusPageComponents,
			});

			if (result.openIncident) {
				// Reset operational streak — provider is degraded.
				operationalPolls[provider.key] = 0;

				const upsert = await upsertIntegrationIncident({
					providerKey: provider.key,
					providerName: provider.displayName,
					health: result.health,
					severity: result.severity,
					detectionMethod: "STATUSPAGE_POLL",
					statusPageUrl: provider.statusPageUrl ?? null,
					statusPageIncidentId: result.openIncident.id,
					affectedComponents: result.openIncident.affectedComponents,
					summary: result.openIncident.name,
				});

				if (upsert.wasNew) {
					// Spawn the lifecycle workflow with a deterministic ID so
					// the Alertmanager webhook handler can signal it by id.
					try {
						await startChild(incidentLifecycleWorkflow, {
							workflowId: `incident-${upsert.incidentId}`,
							args: [
								{
									kind: "integration",
									incidentId: upsert.incidentId,
									providerKey: provider.key,
									providerName: provider.displayName,
									severity: result.severity,
									summary: result.openIncident.name,
									link: `/app/admin/monitoring?incident=${upsert.incidentId}`,
									startedAtIso: new Date().toISOString(),
								} satisfies IncidentLifecycleInput,
							],
							taskQueue: workflowInfo().taskQueue,
							// Best-effort: if a lifecycle workflow for this
							// incident already exists, skip.
							workflowIdReusePolicy: "ALLOW_DUPLICATE",
						});
					} catch (childError) {
						log.warn("Failed to start incidentLifecycleWorkflow", {
							providerKey: provider.key,
							error:
								childError instanceof Error
									? childError.message
									: String(childError),
						});
					}
				}
			} else if (result.shouldCloseExisting) {
				const prev = operationalPolls[provider.key] ?? 0;
				const next = prev + 1;
				operationalPolls[provider.key] = next;

				if (next >= OPERATIONAL_HYSTERESIS) {
					// 2 consecutive operational polls — close the live
					// incident if any.
					await closeIntegrationIncident({
						providerKey: provider.key,
						reason: "STATUSPAGE_RESOLVED",
						note: "2 consecutive operational polls",
					});
					operationalPolls[provider.key] = 0;
				}
			} else {
				// Degraded but no specific open-incident object — still
				// reset the operational streak so we don't accidentally
				// auto-close on a flap.
				operationalPolls[provider.key] = 0;
			}
		} catch (error) {
			log.warn("Status page poll iteration failed", {
				providerKey: provider.key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Pure sleep + continueAsNew — bounds history. The schedule API
	// triggers a fresh run every 2 minutes; the sleep+continue path
	// exists for the case where the Schedule isn't installed.
	await sleep("2m");

	if (iteration + 1 >= MAX_ITER) {
		await continueAsNew<typeof statusPagePollerWorkflow>({
			iteration: 0,
			operationalPolls,
		});
	}
	await continueAsNew<typeof statusPagePollerWorkflow>({
		iteration: iteration + 1,
		operationalPolls,
	});
}
