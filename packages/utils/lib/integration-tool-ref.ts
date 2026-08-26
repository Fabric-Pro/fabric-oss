/**
 * Wire format for the synthetic config ID that binds a discovered
 * `integration__{PROVIDER}` chat tool to the exact integration behind it:
 *
 *   integration:<PROVIDER>:<integrationId>
 *
 * The orchestrator workflow encodes it during tool discovery and the execution
 * activity splits it again before fetching credentials. Those two live in
 * different runtimes (a deterministic workflow sandbox and a Node activity), so
 * the FORMAT is shared here — pure string handling, no IO, clock or env access,
 * hence workflow-safe.
 *
 * Only the shape is shared. Deciding what a mismatch MEANS, and what to tell
 * the model about it, stays with the dispatcher that has the surrounding
 * context.
 */

export const INTEGRATION_TOOL_REF_PREFIX = "integration";

/** Build the config ID stored for a discovered integration tool. */
export function encodeIntegrationToolRef(
	provider: string,
	integrationId: string,
): string {
	return `${INTEGRATION_TOOL_REF_PREFIX}:${provider}:${integrationId}`;
}

/**
 * Split a config ID into its parts, or return `null` when it is not this wire
 * format at all (wrong prefix, wrong segment count, empty ID). Callers decide
 * how to report that, and separately whether the provider is the one they
 * expected.
 */
export function splitIntegrationToolRef(
	configId: string | undefined,
): { provider: string; integrationId: string } | null {
	if (!configId) {
		return null;
	}

	const parts = configId.split(":");
	if (
		parts.length !== 3 ||
		parts[0] !== INTEGRATION_TOOL_REF_PREFIX ||
		!parts[2]
	) {
		return null;
	}

	return { provider: parts[1], integrationId: parts[2] };
}
