/**
 * Repository Integration Health Check Workflow
 *
 * Scheduled workflow that checks the health of all active project repository
 * integrations. Validates tokens, detects expiry, captures rate limit headers,
 * and logs status changes.
 *
 * Sequence pattern: each run does one pass over all active integrations and
 * exits. The Temporal Schedule (see schedules.ts) re-triggers every 30 minutes.
 *
 * Versioning: the original implementation used a long-running while-loop with
 * its own 30-minute wait, signal-based cancellation, and a progress query.
 * The shape change is gated by `patched("one-pass-repo-health-check-2026-04")`
 * so any execution already in-flight at deploy time replays deterministically
 * against the legacy body. In-flight runs can be drained naturally (they
 * continueAsNew every ~50h into the patched branch) or cancelled via the
 * `cancelRepoHealthCheck` signal.
 *
 * Task Queue: "fabric-worker"
 */

import {
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "../activities";

// ============================================================================
// Signals & Queries (retained for in-flight legacy executions)
// ============================================================================

export const cancelRepoHealthCheckSignal = defineSignal(
	"cancelRepoHealthCheck",
);

export const repoHealthCheckProgressQuery = defineQuery<{
	lastRunAt: string | null;
	integrationsChecked: number;
	healthyCount: number;
	unhealthyCount: number;
}>("repoHealthCheckProgress");

export interface RepoHealthCheckInput {
	/** Retained for backward compatibility with existing schedule payloads. */
	intervalMinutes?: number;
}

export interface RepoHealthCheckOutput {
	totalChecked: number;
	healthyCount: number;
	unhealthyCount: number;
}

const { fetchActiveRepoIntegrations, checkRepoIntegrationHealth } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "2m",
		retry: {
			initialInterval: "5s",
			maximumInterval: "1m",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	});

export async function repoIntegrationHealthCheckWorkflow(
	input: RepoHealthCheckInput,
): Promise<RepoHealthCheckOutput> {
	if (patched("one-pass-repo-health-check-2026-04")) {
		return onePassHealthCheck();
	}
	return legacyLoopingHealthCheck(input);
}

// ============================================================================
// New (patched) body — Sequence pattern: one pass per schedule tick.
// ============================================================================

async function onePassHealthCheck(): Promise<RepoHealthCheckOutput> {
	log.info("[RepoHealthCheck] Starting health check cycle");

	const { integrations } = await fetchActiveRepoIntegrations();

	let healthyCount = 0;
	let unhealthyCount = 0;

	for (const integration of integrations) {
		const result = await checkRepoIntegrationHealth({
			integrationId: integration.id,
			provider: integration.provider,
			authMethod: integration.authMethod,
			repositoryUrl: integration.repositoryUrl,
			encryptedAccessToken: integration.encryptedAccessToken,
			encryptedRefreshToken: integration.encryptedRefreshToken,
			encryptedPat: integration.encryptedPat,
			tokenExpiresAt: integration.tokenExpiresAt,
			updatedAt: integration.updatedAt,
			configuredByUserId: integration.configuredByUserId,
			projectId: integration.projectId,
			projectName: integration.projectName,
			organizationId: integration.organizationId,
			repositoryOwner: integration.repositoryOwner,
			repositoryName: integration.repositoryName,
		});

		if (result.healthy) {
			healthyCount++;
		} else {
			unhealthyCount++;
		}
	}

	log.info(
		`[RepoHealthCheck] Cycle complete: ${healthyCount} healthy, ${unhealthyCount} unhealthy out of ${integrations.length}`,
	);

	return {
		totalChecked: integrations.length,
		healthyCount,
		unhealthyCount,
	};
}

// ============================================================================
// Legacy body — preserved verbatim for deterministic replay of in-flight runs.
// Do not modify; remove once all pre-patch executions have drained.
// ============================================================================

async function legacyLoopingHealthCheck(
	input: RepoHealthCheckInput,
): Promise<RepoHealthCheckOutput> {
	const intervalMinutes = input.intervalMinutes ?? 30;
	let cancelled = false;
	let lastRunAt: string | null = null;
	let integrationsChecked = 0;
	let healthyCount = 0;
	let unhealthyCount = 0;
	let iterationCount = 0;

	setHandler(cancelRepoHealthCheckSignal, () => {
		cancelled = true;
	});

	setHandler(repoHealthCheckProgressQuery, () => ({
		lastRunAt,
		integrationsChecked,
		healthyCount,
		unhealthyCount,
	}));

	while (!cancelled) {
		log.info("[RepoHealthCheck] Starting health check cycle");

		const { integrations } = await fetchActiveRepoIntegrations();

		let cycleHealthy = 0;
		let cycleUnhealthy = 0;

		for (const integration of integrations) {
			if (cancelled) {
				break;
			}

			const result = await checkRepoIntegrationHealth({
				integrationId: integration.id,
				provider: integration.provider,
				authMethod: integration.authMethod,
				encryptedAccessToken: integration.encryptedAccessToken,
				encryptedRefreshToken: integration.encryptedRefreshToken,
				encryptedPat: integration.encryptedPat,
				tokenExpiresAt: integration.tokenExpiresAt,
				updatedAt: integration.updatedAt,
				configuredByUserId: integration.configuredByUserId,
				projectId: integration.projectId,
				projectName: integration.projectName,
				organizationId: integration.organizationId,
				repositoryOwner: integration.repositoryOwner,
				repositoryName: integration.repositoryName,
			});

			if (result.healthy) {
				cycleHealthy++;
			} else {
				cycleUnhealthy++;
			}
		}

		lastRunAt = new Date().toISOString();
		integrationsChecked = integrations.length;
		healthyCount = cycleHealthy;
		unhealthyCount = cycleUnhealthy;
		iterationCount++;

		log.info(
			`[RepoHealthCheck] Cycle complete: ${cycleHealthy} healthy, ${cycleUnhealthy} unhealthy out of ${integrations.length}`,
		);

		if (iterationCount >= 100) {
			await continueAsNew<typeof repoIntegrationHealthCheckWorkflow>(
				input,
			);
		}

		const wasCancelled = await condition(
			() => cancelled,
			intervalMinutes * 60 * 1000,
		);
		if (wasCancelled) {
			break;
		}
	}

	return {
		totalChecked: integrationsChecked,
		healthyCount,
		unhealthyCount,
	};
}
