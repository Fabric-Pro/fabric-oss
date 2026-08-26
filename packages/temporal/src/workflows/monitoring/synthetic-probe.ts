/**
 * syntheticProbeWorkflow.
 *
 * One workflow instance per probed provider. The set of probed providers
 * is read from the integration-provider registry at boot time via
 * `getProvidersForSyntheticProbe()` — adding a new probed provider is a
 * one-line registry change with NO workflow code edits.
 *
 * Each instance:
 *   - Runs the generic `runSyntheticProbe(providerKey)` activity every
 *     5 minutes. The activity reads the per-provider probe spec from
 *     the same registry and dispatches to either the generic HTTP path
 *     or a whitelisted SDK function (currently only `s3-head-canary`).
 *   - Maintains a ring buffer of the last N probe results (N = 3 +
 *     safety) so it can:
 *       a. Open a SEV-2 IntegrationIncident after 3 consecutive
 *          failures.
 *       b. Close the active incident after 3 consecutive successes
 *          (auto-resolve hysteresis).
 *
 * A "double-check against the Prometheus signal at fire time" pattern is
 * deferred to v2 — the in-workflow consecutive-failure counter is
 * sufficient signal for v1 and avoids a cross-stack dependency on
 * Prometheus availability at fire time.
 *
 * Cron-via-continueAsNew + Temporal Schedule API. The Schedule API
 * triggers a new run every 5 minutes; the workflow's own sleep + CAN
 * is defense-in-depth.
 */
import {
	continueAsNew,
	log,
	patched,
	proxyActivities,
	sleep,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";
import type {
	IncidentSeverity,
	SyntheticProbeProviderKey,
} from "../../activities/monitoring";
import {
	type IncidentLifecycleInput,
	incidentLifecycleWorkflow,
} from "./incident-lifecycle";

const {
	runSyntheticProbe,
	upsertIntegrationIncident,
	closeIntegrationIncident,
	markProviderNotConfigured,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: { initialInterval: "2s", maximumAttempts: 1 },
});

const FAILURE_THRESHOLD = 3; // open after 3 consecutive failures
const SUCCESS_THRESHOLD = 3; // close after 3 consecutive successes
const MAX_ITER = 288; // ~24h of 5-minute ticks

export interface SyntheticProbeWorkflowInput {
	providerKey: SyntheticProbeProviderKey;
	iteration?: number;
	/** Count of consecutive failures so far. */
	consecutiveFailures?: number;
	/** Count of consecutive successes since the last failure. */
	consecutiveSuccesses?: number;
	/** True when we've opened an incident and are waiting for recovery. */
	incidentOpen?: boolean;
}

/**
 * Display name lookup — kept inline because the workflow can't import
 * the registry (it's bundled separately for the Temporal sandbox).
 * Falls back to the providerKey itself so adding a new probed provider
 * still works — the operator sees the raw key in the incident UI until
 * a new entry is added here.
 *
 * Keep in sync with `packages/observability/lib/integration-providers.ts`.
 */
function displayName(providerKey: SyntheticProbeProviderKey): string {
	switch (providerKey) {
		case "openai":
			return "OpenAI";
		case "anthropic":
			return "Anthropic";
		case "stripe":
			return "Stripe";
		case "resend":
			return "Resend";
		case "aws_s3":
			return "AWS S3";
		default:
			return providerKey;
	}
}

/**
 * Severity for a probe-driven incident: SEV-2 at the 3-consecutive-failure
 * threshold. Higher severity (SEV-1) takes 5 consecutive failures, which
 * is currently out of scope for this v1 workflow; Alertmanager handles
 * the SEV-1 escalation off the same `synthetic_probe_result_total` metric.
 */
function probeSeverity(): IncidentSeverity {
	return "SEV2";
}

export async function syntheticProbeWorkflow(
	input: SyntheticProbeWorkflowInput,
): Promise<void> {
	const iteration = input.iteration ?? 0;
	let consecutiveFailures = input.consecutiveFailures ?? 0;
	let consecutiveSuccesses = input.consecutiveSuccesses ?? 0;
	let incidentOpen = input.incidentOpen ?? false;

	let probeResult: {
		success: boolean;
		error?: string;
		notConfigured?: boolean;
	};
	try {
		probeResult = await runSyntheticProbe(input.providerKey);
	} catch (err) {
		log.warn("Synthetic probe activity threw", {
			providerKey: input.providerKey,
			error: err instanceof Error ? err.message : String(err),
		});
		probeResult = {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// NOT_CONFIGURED short-circuit. A missing env var (e.g.,
	// STRIPE_SECRET_KEY unset in staging) is NOT a probe failure — the
	// provider itself is not necessarily down, we just have no
	// credentials to probe with from this environment. Mark the
	// registry row as NOT_CONFIGURED so the admin UI shows a neutral
	// gray badge instead of a red outage, reset counters, and continue
	// without opening an incident.
	//
	// Two cases:
	//   a) The provider was previously OPERATIONAL and a fresh redeploy
	//      removed the credential — `incidentOpen` is false locally, the
	//      registry row flips to NOT_CONFIGURED, and we do not need to
	//      touch any incident row.
	//   b) The provider had a SYNTHETIC_PROBE incident open from before
	//      the NOT_CONFIGURED state existed (the case the user reported
	//      on staging: two SEV-2 rows for AWS S3 and Stripe stuck at
	//      "9h ago" because the probe failures opened the incidents
	//      pre-#1019, and the post-#1019 NOT_CONFIGURED transitions
	//      never closed them). For (b) we additionally call
	//      `closeIntegrationIncident({ reason: "NOT_CONFIGURED" })` which
	//      walks the most recent FIRING/ACKNOWLEDGED row for the
	//      provider, marks it RESOLVED, and writes
	//      `IncidentEvent(AUTO_RESOLVED, payload.reason="NOT_CONFIGURED")`.
	//      The registry row's NOT_CONFIGURED health is preserved.
	//
	// Best-effort: a failure to close does NOT block the registry flip —
	// the admin can still resolve the stale incident manually from the
	// dashboard. We continue the workflow either way.
	//
	// Only the NEW `closeIntegrationIncident` activity is wrapped in
	// `patched()`. The `markProviderNotConfigured` activity already
	// existed in the workflow's pre-#1022 history (added in #1019),
	// so calling it on replay matches the recorded
	// ActivityTaskScheduled at the same position. The new
	// `closeIntegrationIncident` activity, however, would introduce a
	// foreign ActivityTaskScheduled before the recorded
	// TimerStarted, breaking determinism — hence the marker.
	if (probeResult.notConfigured) {
		try {
			await markProviderNotConfigured({
				providerKey: input.providerKey,
				reason: probeResult.error,
			});
		} catch (err) {
			log.warn("Failed to mark provider as NOT_CONFIGURED", {
				providerKey: input.providerKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Gated by `patched()` so in-flight workflow runs replay through
		// the pre-#1022 history (markProviderNotConfigured → sleep →
		// continueAsNew) without scheduling the extra
		// closeIntegrationIncident activity. Fresh executions started
		// after deploy emit the marker and take the new branch.
		if (patched("synthetic-probe-close-not-configured-2026-05-16")) {
			try {
				// Use the per-provider registry as the source of truth
				// rather than `incidentOpen` — the local flag only
				// tracks incidents opened by THIS workflow run, not
				// orphaned rows that existed before NOT_CONFIGURED was
				// added. Always attempting the close is idempotent:
				// it's a no-op when no active row matches.
				const closeResult = await closeIntegrationIncident({
					providerKey: input.providerKey,
					reason: "NOT_CONFIGURED",
					note:
						probeResult.error ??
						"Provider transitioned to NOT_CONFIGURED — closing stale synthetic-probe incident.",
				});
				if (closeResult.resolved) {
					// Reset the workflow-local flag so the lifecycle
					// workflow's resolvedSignal isn't ambiguous about
					// whether the row is already closed.
					incidentOpen = false;
				}
			} catch (err) {
				log.warn(
					"Failed to close stale synthetic-probe incident on NOT_CONFIGURED transition",
					{
						providerKey: input.providerKey,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}

		consecutiveFailures = 0;
		consecutiveSuccesses = 0;

		await sleep("5m");
		if (iteration + 1 >= MAX_ITER) {
			await continueAsNew<typeof syntheticProbeWorkflow>({
				providerKey: input.providerKey,
				iteration: 0,
				consecutiveFailures,
				consecutiveSuccesses,
				incidentOpen,
			});
		}
		await continueAsNew<typeof syntheticProbeWorkflow>({
			providerKey: input.providerKey,
			iteration: iteration + 1,
			consecutiveFailures,
			consecutiveSuccesses,
			incidentOpen,
		});
		return;
	}

	if (probeResult.success) {
		consecutiveFailures = 0;
		consecutiveSuccesses += 1;

		if (incidentOpen && consecutiveSuccesses >= SUCCESS_THRESHOLD) {
			try {
				await closeIntegrationIncident({
					providerKey: input.providerKey,
					reason: "PROBE_SUCCESS",
					note: `${SUCCESS_THRESHOLD} consecutive successful probes`,
				});
			} catch (err) {
				log.warn("Failed to close integration incident from probe", {
					providerKey: input.providerKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
			incidentOpen = false;
			consecutiveSuccesses = 0;
		}
	} else {
		consecutiveSuccesses = 0;
		consecutiveFailures += 1;

		if (!incidentOpen && consecutiveFailures >= FAILURE_THRESHOLD) {
			try {
				const upsert = await upsertIntegrationIncident({
					providerKey: input.providerKey,
					providerName: displayName(input.providerKey),
					health: "MAJOR_OUTAGE",
					severity: probeSeverity(),
					detectionMethod: "SYNTHETIC_PROBE",
					summary:
						probeResult.error ??
						`${FAILURE_THRESHOLD} consecutive synthetic probe failures`,
				});

				if (upsert.wasNew) {
					try {
						await startChild(incidentLifecycleWorkflow, {
							workflowId: `incident-${upsert.incidentId}`,
							args: [
								{
									kind: "integration",
									incidentId: upsert.incidentId,
									providerKey: input.providerKey,
									providerName: displayName(
										input.providerKey,
									),
									severity: probeSeverity(),
									summary:
										probeResult.error ??
										`${FAILURE_THRESHOLD} consecutive synthetic probe failures`,
									link: `/app/admin/monitoring?incident=${upsert.incidentId}`,
									startedAtIso: new Date().toISOString(),
								} satisfies IncidentLifecycleInput,
							],
							taskQueue: workflowInfo().taskQueue,
							workflowIdReusePolicy: "ALLOW_DUPLICATE",
						});
					} catch (childErr) {
						log.warn("Failed to start lifecycle from probe", {
							providerKey: input.providerKey,
							error:
								childErr instanceof Error
									? childErr.message
									: String(childErr),
						});
					}
				}
				incidentOpen = true;
			} catch (err) {
				log.warn("Failed to upsert integration incident from probe", {
					providerKey: input.providerKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	await sleep("5m");

	if (iteration + 1 >= MAX_ITER) {
		await continueAsNew<typeof syntheticProbeWorkflow>({
			providerKey: input.providerKey,
			iteration: 0,
			consecutiveFailures,
			consecutiveSuccesses,
			incidentOpen,
		});
	}
	await continueAsNew<typeof syntheticProbeWorkflow>({
		providerKey: input.providerKey,
		iteration: iteration + 1,
		consecutiveFailures,
		consecutiveSuccesses,
		incidentOpen,
	});
}
