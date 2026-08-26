/**
 * The log-source provider registry (Fizzy #1234).
 *
 * Fabric is not tied to any log platform. The port
 * (`@repo/ai/lib/log-context`) defines what a log source must do; a PROVIDER
 * is one implementation plus the configuration that selects it. Adding
 * Grafana Loki, Elastic, Datadog or a customer's in-house API means writing a
 * `LogSourceProvider` and adding it to `PROVIDERS` — nothing above this file
 * changes, and no other provider is touched.
 *
 * Azure Monitor happens to be the first entry because Fabric's own telemetry
 * already lands there, so it is the one platform reachable for verification.
 * That is availability, not preference, and nothing in the port, the redaction
 * layer, the property policy or the prompt assembly knows the name Azure.
 *
 * Selection order:
 *   1. `FABRIC_BUG_ANALYSIS_LOG_PROVIDER` names a provider explicitly.
 *   2. Otherwise the first provider that finds its own configuration wins.
 *   3. Otherwise `null` — FR3's "not configured", an ordinary outcome.
 */
import type { LogSourceAdapter } from "@repo/ai/lib/log-context";
import { logger } from "@repo/logs";
import { azureMonitorProvider } from "./azure-monitor-log-source";

export interface LogSourceProvider {
	/** Stable id used by `FABRIC_BUG_ANALYSIS_LOG_PROVIDER`. */
	readonly id: string;
	/** Human label, shown to the user in the FR3 note. */
	readonly label: string;
	/**
	 * Build an adapter from this deployment's environment, or return `null`
	 * when this provider is not configured. Must not perform I/O — resolution
	 * stays cheap and failures surface on the fetch, where the port already
	 * degrades to "unavailable".
	 */
	fromEnvironment(): LogSourceAdapter | null;
	/**
	 * Build an adapter from a PROJECT's stored settings, or `null` when they
	 * are unusable. Same no-I/O rule as `fromEnvironment`.
	 */
	fromProjectConfig(config: Record<string, unknown>): LogSourceAdapter | null;
}

/**
 * Every known provider. Order matters only for auto-detection.
 *
 * To add one: implement `LogSourceProvider` in its own file, read its own
 * environment variables in `fromEnvironment`, and append it here.
 */
export const PROVIDERS: readonly LogSourceProvider[] = [azureMonitorProvider];

/**
 * Build an adapter from a project's own binding.
 *
 * A project that names a provider gets that provider or nothing — never a
 * silent fallback to the deployment default, for the same reason an unknown
 * provider name does not fall back: using a log source nobody named is worse
 * than using none.
 */
export function resolveProjectLogSource(
	providerId: string,
	config: Record<string, unknown>,
	providers: readonly LogSourceProvider[] = PROVIDERS,
): LogSourceAdapter | null {
	const provider = providers.find((p) => p.id === providerId);
	if (!provider) {
		logger.warn("[BugAnalysis] project names an unknown log provider", {
			providerId,
			known: providers.map((p) => p.id),
		});
		return null;
	}
	const adapter = provider.fromProjectConfig(config);
	if (!adapter) {
		logger.warn(
			"[BugAnalysis] project log-source settings are incomplete",
			{
				providerId,
			},
		);
	}
	return adapter;
}

/** The provider ids a deployment may name, for error messages and docs. */
export function knownProviderIds(): string[] {
	return PROVIDERS.map((provider) => provider.id);
}

/**
 * Resolve this deployment's configured log source, or `null` when none is.
 *
 * Exported for tests; production reaches it through `resolveLogSourceAdapter`.
 */
export function resolveConfiguredLogSource(
	providers: readonly LogSourceProvider[] = PROVIDERS,
): LogSourceAdapter | null {
	const requested = process.env.FABRIC_BUG_ANALYSIS_LOG_PROVIDER?.trim();

	if (requested) {
		const provider = providers.find((p) => p.id === requested);
		if (!provider) {
			logger.warn("[BugAnalysis] unknown log provider requested", {
				requested,
				known: providers.map((p) => p.id),
			});
			return null;
		}
		const adapter = provider.fromEnvironment();
		if (!adapter) {
			logger.warn("[BugAnalysis] named log provider is not configured", {
				provider: provider.id,
			});
		}
		return adapter;
	}

	for (const provider of providers) {
		const adapter = provider.fromEnvironment();
		if (adapter) {
			return adapter;
		}
	}
	return null;
}
