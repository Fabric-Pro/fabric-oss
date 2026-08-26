/**
 * Test-case PUSH/PULL sync gate.
 *
 * Test cases only sync to a PM tool that holds a NATIVE test-case entity (or a
 * recognized analogue): Azure DevOps ("Test Case" work item + native Steps),
 * Jira via Xray/Zephyr, or GitLab test cases. A tool that only knows generic
 * issues/cards (Fizzy, GitHub, vanilla Jira/GitLab) is gated OFF — a test case
 * must never be written there as a plain issue with its steps stuffed into the
 * body.
 *
 * The live probe (`getPMToolCapabilities`) reports `supportsTestCases`, derived
 * from the connection's discovered tools (`hasNativeTestCaseSupport`). This is
 * the SAME discovery the `pmCapabilities` procedure the UI gates on uses, so the
 * button enablement and the API agree.
 *
 * `classifyTestCaseSyncSupport` returns a TRI-STATE so callers can treat a
 * can't-confirm probe (`unknown` — the MCP was transiently unreachable)
 * differently from a definitive `unsupported`. Explicit sync fails fast on both;
 * the fire-and-forget auto-sync is lenient on `unknown`.
 */

import { ORPCError } from "@orpc/client";
import { pmDetectedTypeDisplayName } from "@repo/utils";

/**
 * The subset of a {@link resolvePmTarget} result this gate needs. A non-MCP
 * target (`kind: "rest-gitlab"` — the GitLab REST fallback) has no native
 * test-case entity, so it is blocked without a probe.
 */
export interface ResolvedSyncTarget {
	kind: string;
	mcpConfigId?: string | null;
}

/**
 * `supported` — the tool holds native test cases and can perform the direction.
 * `unsupported` — DEFINITIVELY no native test cases (or can't do the op).
 * `unknown` — the capability probe failed / returned nothing, so support could
 * not be confirmed either way (typically a transient MCP outage).
 */
type TestCaseSyncSupport = "supported" | "unsupported" | "unknown";

export interface TestCaseSyncSupportResult {
	support: TestCaseSyncSupport;
	/** Human provider name for the reason message, or null when unresolved. */
	providerLabel: string | null;
}

/** The user-facing reason a `direction` sync is refused as unsupported. */
function testCaseSyncUnsupportedMessage(
	providerLabel: string | null,
	direction: "push" | "pull",
): string {
	const label = providerLabel ?? "Your connected PM tool";
	return direction === "pull"
		? `${label} doesn't have native test cases, so test cases can't be pulled from it.`
		: `${label} doesn't have native test cases, so test cases can't be pushed to it.`;
}

/** The user-facing reason when the tool's support couldn't be confirmed (probe failed). */
function testCaseSyncUnreachableMessage(providerLabel: string | null): string {
	const label = providerLabel ?? "your connected PM tool";
	return `Couldn't reach ${label} to confirm test-case support. Check the connection and try again.`;
}

/**
 * Resolve whether the connected PM tool holds a native test-case entity (or
 * analogue) AND can perform the requested `direction`. Distinguishes a definitive
 * `unsupported` from an `unknown` (probe failure) so a transient MCP outage isn't
 * mistaken for "this tool has no test cases".
 */
export async function classifyTestCaseSyncSupport(
	target: ResolvedSyncTarget,
	direction: "push" | "pull",
	actor: { userId: string; organizationId: string | null },
): Promise<TestCaseSyncSupportResult> {
	// Non-MCP targets (the GitLab REST fallback) have no native test-case entity —
	// definitively unsupported, no probe available or needed.
	if (target.kind !== "mcp" || !target.mcpConfigId) {
		return { support: "unsupported", providerLabel: null };
	}

	const { getPMToolCapabilities } = await import("@repo/temporal");
	let caps: Awaited<ReturnType<typeof getPMToolCapabilities>>;
	try {
		caps = await getPMToolCapabilities({
			mcpConfigId: target.mcpConfigId,
			userId: actor.userId,
			organizationId: actor.organizationId ?? undefined,
		});
	} catch {
		// The probe threw (MCP transiently unreachable) — we can't say the tool is
		// unsupported, only that support couldn't be confirmed.
		return { support: "unknown", providerLabel: null };
	}

	// A null probe means the connection couldn't be discovered (disabled /
	// unreachable), NOT that the tool lacks test cases — treat as unknown.
	if (!caps) {
		return { support: "unknown", providerLabel: null };
	}

	const label = pmDetectedTypeDisplayName(caps.detectedType ?? null) ?? null;
	const crudSupported =
		direction === "pull"
			? Boolean(caps.canGet || caps.canList)
			: Boolean(caps.canCreate || caps.canUpdate);
	if (caps.supportsTestCases && crudSupported) {
		return { support: "supported", providerLabel: label };
	}
	return { support: "unsupported", providerLabel: label };
}

/**
 * Throw a BAD_REQUEST unless the connected PM tool can perform the requested
 * test-case sync. Used by the EXPLICIT sync entry points (a user action), which
 * fail fast on both `unsupported` AND `unknown` so the caller gets immediate,
 * accurate feedback instead of a silent no-op. (Auto-sync uses
 * `classifyTestCaseSyncSupport` directly and is lenient on `unknown`.)
 */
export async function assertTestCaseSyncSupported(
	target: ResolvedSyncTarget,
	direction: "push" | "pull",
	actor: { userId: string; organizationId: string | null },
): Promise<void> {
	const { support, providerLabel } = await classifyTestCaseSyncSupport(
		target,
		direction,
		actor,
	);
	if (support === "supported") {
		return;
	}
	throw new ORPCError("BAD_REQUEST", {
		message:
			support === "unknown"
				? testCaseSyncUnreachableMessage(providerLabel)
				: testCaseSyncUnsupportedMessage(providerLabel, direction),
	});
}
