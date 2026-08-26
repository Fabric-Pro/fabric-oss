/**
 * Read-only mode write-gate + the web/API external-dispatch funnel (Fizzy #2007).
 *
 * `callMcpTool` is the one place every web/API MCP tool dispatch must flow
 * through — the MCP-App proxy routes and the `mcp.executeTool` /
 * `mcp.fetchResources` procedures all call it, passing their own dispatch
 * closure. It classifies the tool, resolves the owning project (explicit arg →
 * ambient AsyncLocalStorage), and blocks a WRITE-classified call when that
 * project is in Read-only mode — BEFORE the closure runs, so nothing reaches
 * the external source.
 *
 * The Temporal worker does NOT import this module: it uses the deliberately
 * mirrored twin in `packages/temporal/src/activities/shared/read-only-gate.ts`
 * (kept separate so activity tests that mock `@repo/mcp` keep the gate). If you
 * change the classification or block shape, change BOTH copies. A CI guard
 * (`packages/api/__tests__/mcp-dispatch-readonly-gate-guard.test.ts`) fails the
 * build if a new web/API dispatch bypasses this funnel.
 */

import { isProjectReadOnly } from "@repo/database";
import { getAmbientProjectId } from "@repo/utils/project-context";
import {
	buildReadOnlyBlockedOutput,
	classifyReadOnlyToolAccess,
	type ReadOnlyBlockedOutput,
} from "@repo/utils/read-only-mode";

/**
 * Decide whether a tool call must be blocked by Read-only mode. Returns the
 * structured block output to hand straight back to the caller, or `null` when
 * the call is allowed.
 *
 * No name-based exemptions: everything dispatched through this funnel targets a
 * user-configured EXTERNAL server, and a third party is free to name a write
 * tool `fabric_update_page` — the earlier `fabric_*` exemption here was a write
 * escape (post-ship review finding). The worker-side twin keeps an explicit
 * opt-in exemption solely for the in-process Fabric AI tool switch.
 */
export async function guardToolWriteForReadOnly(
	projectId: string | undefined | null,
	toolName: string,
): Promise<ReadOnlyBlockedOutput | null> {
	const resolvedProjectId = projectId ?? getAmbientProjectId();
	if (
		resolvedProjectId &&
		classifyReadOnlyToolAccess(toolName) === "WRITE" &&
		(await isProjectReadOnly(resolvedProjectId))
	) {
		return buildReadOnlyBlockedOutput(toolName);
	}
	return null;
}

export interface CallMcpToolOptions<T> {
	/** The tool's original (server-side) name — used for write classification. */
	toolName: string;
	/**
	 * Owning project id. Optional — when omitted the gate reads the ambient
	 * project context (set by the oRPC/Temporal/route entry points). Pass it
	 * explicitly when it is already in scope.
	 */
	projectId?: string | null;
	/** The actual dispatch to the external source (any transport). */
	execute: () => Promise<T>;
}

/**
 * The single external-MCP-dispatch funnel. Runs the Read-only gate, then the
 * caller's dispatch closure. Returns the structured block output (never runs
 * `execute`) when the project is read-only and the tool is a write; otherwise
 * returns whatever `execute` returns.
 */
export async function callMcpTool<T>(
	opts: CallMcpToolOptions<T>,
): Promise<T | ReadOnlyBlockedOutput> {
	const blocked = await guardToolWriteForReadOnly(
		opts.projectId,
		opts.toolName,
	);
	if (blocked) {
		return blocked;
	}
	return opts.execute();
}
