/**
 * Read-only mode — worker-side external-dispatch gate guard.
 *
 * THE BUG THIS PREVENTS: a Temporal activity that dispatches to an external
 * service (MCP client, GitHub/Teams OAuth executors) WITHOUT consulting the
 * read-only gate — so a write escapes while the project is in Read-only mode.
 * The 2026-07-23 post-ship review found two shipped instances of exactly this
 * (the task-agent tool loop and the legacy Fizzy push), both invisible to the
 * api-side guard because it only scans web/API surfaces.
 *
 * THE RULE: every activity module that imports an external-dispatch primitive
 * must reference the gate (`guardToolWriteForReadOnly` / `isProjectReadOnly` /
 * `callMcpTool`) or appear in the allowlist below with a justification proving
 * it cannot write externally (read-only tool surface, or a primitive whose
 * call sites are gated).
 *
 * If this fails on your new activity, do NOT allowlist it first — thread the
 * owning projectId into the activity input (top-level `projectId`, which also
 * feeds the ambient-context interceptor) and call
 * `guardToolWriteForReadOnly(projectId, toolName)` before the dispatch.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const activitiesRoot = resolve(__dirname, "..");
const repoRoot = resolve(activitiesRoot, "../../../..");

/** Importing any of these means the module can reach an external service. */
const EXTERNAL_DISPATCH_RE =
	/executeGitHubTool|executeMicrosoftTeamsTool|getCachedMcpClientForConfig|createMcpClient\b/;

/** The module consults the read-only gate somewhere. */
const GATE_REF_RE = /guardToolWriteForReadOnly|isProjectReadOnly|callMcpTool/;

/**
 * Modules verified (2026-07-23 five-lens review) to be unable to write to a
 * connected source. Every entry needs a justification a reviewer can check.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		"packages/temporal/src/activities/backlog-context/fetch-context.ts",
		"Teams meeting/transcript READS only (list/get) — no write operations",
	],
	[
		"packages/temporal/src/activities/deep-researcher/execution.ts",
		"surfaces search/scrape tools only — no write tools exposed to the loop",
	],
	[
		"packages/temporal/src/activities/meeting-transcript-sync.ts",
		"Teams transcript READS only (list meetings / get transcript content)",
	],
	[
		"packages/temporal/src/activities/orchestrator/execution/context/tool-loader.ts",
		"loads tool DEFINITIONS for the planner — dispatch happens in the gated executeMcpTool chokepoint",
	],
	[
		"packages/temporal/src/activities/search-project-teams-messages.ts",
		"Teams message search — READ only",
	],
	[
		"packages/temporal/src/activities/shared/oauth-tool-executors.ts",
		"shared executor PRIMITIVE — gating happens at every dispatch call site (chokepoint, task-agent, agent-executor)",
	],
	[
		"packages/temporal/src/activities/teams-channel-monitor/fetch-new-messages.ts",
		"channel message READS (conversations.history-style) — no writes",
	],
	[
		"packages/temporal/src/activities/teams-chat-monitor/fetch-new-messages.ts",
		"chat message READS — no writes",
	],
	[
		"packages/temporal/src/activities/template-instance/report-agent-loop.ts",
		"write tools stripped by isReadOnlyTool() before the loop — read-only by construction (model also carries no projectId)",
	],
]);

// Never descend into build artifacts / dependency trees (same pruning as the
// api-side guard — the unpruned recursive walk OOM'd a CI vitest worker).
const SKIP_DIRS = new Set([
	"node_modules",
	".turbo",
	"dist",
	"coverage",
	"generated",
	"__tests__",
]);

function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) {
				continue;
			}
			out.push(...walkTsFiles(resolve(root, entry.name)));
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		if (!entry.name.endsWith(".ts")) {
			continue;
		}
		if (entry.name.endsWith(".test.ts")) {
			continue;
		}
		if (entry.name.endsWith(".d.ts")) {
			continue;
		}
		out.push(resolve(root, entry.name));
	}
	return out;
}

describe("worker external-dispatch read-only gate guard", () => {
	it("every activity module importing an external-dispatch primitive consults the read-only gate or is a justified read-only allowlist entry", () => {
		const offenders: string[] = [];
		for (const absFile of walkTsFiles(activitiesRoot)) {
			const content = readFileSync(absFile, "utf-8");
			if (!EXTERNAL_DISPATCH_RE.test(content)) {
				continue;
			}
			if (GATE_REF_RE.test(content)) {
				continue;
			}
			const file = relative(repoRoot, absFile).split(sep).join("/");
			if (ALLOWLIST.has(file)) {
				continue;
			}
			offenders.push(file);
		}

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} activity module(s) can dispatch externally without consulting the Read-only gate ` +
					"(a write could escape while a project is in Read-only mode):\n\n" +
					offenders.map((f) => `  ${f}`).join("\n") +
					"\n\nFix: thread the owning projectId (top-level on the activity input) and call " +
					"`guardToolWriteForReadOnly(projectId, toolName)` from activities/shared/read-only-gate " +
					"before the dispatch. Only allowlist a module you have PROVEN cannot write externally.",
			);
		}

		expect(offenders.length).toBe(0);
	});

	it("allowlist entries still exist and still lack gate refs (no stale excuses)", () => {
		for (const [file, justification] of ALLOWLIST) {
			expect(justification.length).toBeGreaterThan(10);
			const abs = resolve(repoRoot, file);
			let content: string;
			try {
				content = readFileSync(abs, "utf-8");
			} catch {
				throw new Error(
					`Allowlist entry no longer exists — remove it: ${file}`,
				);
			}
			if (GATE_REF_RE.test(content)) {
				throw new Error(
					`Allowlist entry now references the gate — remove the stale entry: ${file}`,
				);
			}
		}
	});
});
