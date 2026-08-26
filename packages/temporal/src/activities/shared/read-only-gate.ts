/**
 * Read-only mode write-gate for in-process Temporal tool execution.
 *
 * The direct-chat, deployed-agent, and orchestrator tool wrappers — and the
 * executeMcpTool chokepoint — call this before dispatching an MCP/OAuth tool.
 * It mirrors the canonical funnel in `@repo/mcp` (`callMcpTool`) exactly; the
 * logic is kept self-contained here (importing the primitives directly rather
 * than re-exporting `@repo/mcp`) so the many Temporal activity tests that mock
 * `@repo/mcp` for its client factory don't lose the gate. If you change the
 * classification or block shape, change both this and `@repo/mcp`'s copy.
 *
 * `projectId` is resolved explicitly first, then from the ambient project
 * context the Temporal activity interceptor sets from the activity input — so a
 * new activity that forgets to thread it is still covered.
 */

import { isProjectReadOnly } from "@repo/database";
import { getAmbientProjectId } from "@repo/utils/project-context";
import {
	buildReadOnlyBlockedOutput,
	classifyReadOnlyToolAccess,
	type ReadOnlyBlockedOutput,
} from "@repo/utils/read-only-mode";

export async function guardToolWriteForReadOnly(
	projectId: string | undefined | null,
	toolName: string,
	opts?: {
		/**
		 * Exempt `fabric_*` tool names from the gate. ONLY for call sites that
		 * front the in-process Fabric AI tool switch (the executeMcpTool
		 * chokepoint), where those names are internal operations that must keep
		 * working in read-only mode. Sites that dispatch to EXTERNAL servers
		 * must NOT set this — a third-party server is free to name a write tool
		 * `fabric_update_page`, and the name alone proves nothing (post-ship
		 * review finding). The chokepoint re-gates strictly when an unknown
		 * `fabric_*` name falls through to external MCP dispatch.
		 */
		exemptFabricInternalTools?: boolean;
		/**
		 * Trusted READ/WRITE for this call, used INSTEAD of classifying the
		 * name. Only for callers holding a first-party declaration of the
		 * operation's effect — currently the integration executor registry,
		 * where the provider declares each operation's access. The name
		 * heuristic cannot be trusted there in either direction: it reads
		 * `decode_vin` as a write and would read a registered write called
		 * `query_and_purge` as a read.
		 */
		accessOverride?: "READ" | "WRITE";
	},
): Promise<ReadOnlyBlockedOutput | null> {
	const resolvedProjectId = projectId ?? getAmbientProjectId();
	if (
		resolvedProjectId &&
		!(
			opts?.exemptFabricInternalTools &&
			toolName.toLowerCase().startsWith("fabric_")
		) &&
		// Inline so the classifier is only consulted once the cheaper guards
		// above have passed, and never when an override is supplied.
		(opts?.accessOverride ?? classifyReadOnlyToolAccess(toolName)) ===
			"WRITE" &&
		(await isProjectReadOnly(resolvedProjectId))
	) {
		return buildReadOnlyBlockedOutput(toolName);
	}
	return null;
}
