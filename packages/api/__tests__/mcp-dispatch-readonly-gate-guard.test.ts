/**
 * Read-only mode — external-dispatch gate regression guard.
 *
 * THE BUG THIS PREVENTS: a route/procedure that dispatches an MCP tool to a
 * connected external source WITHOUT routing through the shared `callMcpTool`
 * funnel — so a write escapes even while the project is in Read-only mode. This
 * is exactly how the AI diagram `create_view` write leaked through
 * `/api/mcp-app/invoke` before the funnel existed.
 *
 * THE RULE: every file on the web/API MCP-dispatch surface (the MCP-App proxy
 * routes and the `mcp` API procedures) that actually dispatches a tool
 * (`.execute(` / `.callTool(`) using an MCP client MUST reference `callMcpTool`
 * — the funnel that runs the Read-only gate before dispatch.
 *
 * If this fails on your new file, do NOT allowlist it — route the dispatch
 * through `callMcpTool({ toolName, projectId, execute })` from `@repo/mcp`.
 * (The Temporal worker path is covered separately: its dispatch chokepoint is
 * gated and every activity gets ambient project context from the activity
 * interceptor.)
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

// The web/API surfaces where MCP dispatches live and where new ones will be
// added. Deliberately BROAD (post-ship review finding: the original two roots
// missed /api/pipeline/mcp-tool, the fabric tool-router, and the MCP gateway).
const SCAN_ROOTS = [
	resolve(repoRoot, "apps/web/app/api"),
	resolve(repoRoot, "apps/web/modules/saas/mcp"),
	resolve(repoRoot, "packages/api/modules"),
];

// The file uses an MCP client (raw SDK or the shared factory).
const MCP_CLIENT_RE =
	/createMcpClientForConfig|@modelcontextprotocol\/sdk|\.tools\(\)/;
// It actually dispatches a tool.
const DISPATCH_RE = /\.(callTool|execute)\s*\(/;
// It routes that dispatch through the read-only funnel.
const FUNNEL_RE = /\bcallMcpTool\s*\(/;

/** Files provably not an external dispatch (each needs a justification). */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		"apps/web/app/api/mcp/test-connection/route.ts",
		"connection test — dispatches ONE safe-pattern READ tool (list_/get_/read_ prefixes enforced in code) with empty args to verify auth; org-level config testing, no project",
	],
	[
		"apps/web/app/api/pipeline/fizzy-boards/route.ts",
		"fixed READ tool only (fizzy_get_boards) — board picker for PM-sync setup",
	],
	[
		"apps/web/app/api/pipeline/fizzy-columns/route.ts",
		"fixed READ tool only (fizzy_get_columns) — column picker for PM-sync setup",
	],
	[
		"apps/web/modules/saas/mcp/lib/gateway/tool-aggregator.ts",
		"MCP gateway for external clients (Claude Desktop/Cursor) — GatewaySession is org-scoped with no project dimension (verified 2026-07-23)",
	],
	[
		"packages/api/modules/projects/procedures/github/list-repos.ts",
		"fixed READ tools only (search_repositories, get_me) — repo picker",
	],
]);

// Never descend into these: build artifacts and dependency trees are not
// dispatch surfaces, and recursively reading them OOMs the CI runner (this
// exact guard took the whole @repo/api vitest worker down before pruning).
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"coverage",
	"generated",
	"__tests__",
]);

function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out; // root may not exist in some checkouts
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

// Raw provider-write primitive that bypasses the MCP funnel entirely. Slack's
// chat.postMessage is the unambiguous one; a file that posts to it must consult
// the Read-only gate (project present) or be an allowlisted no-project boundary.
const RAW_SLACK_WRITE_RE = /chat\.postMessage/;
const GATE_REF_RE = /guardToolWriteForReadOnly|isProjectReadOnly|callMcpTool/;
// Broad on purpose (post-ship review finding: the original single root missed
// the web tool-router's raw Slack executor and packages/integrations).
const RAW_WRITE_SCAN_ROOTS = [
	resolve(repoRoot, "packages/temporal/src"),
	resolve(repoRoot, "apps/web"),
	resolve(repoRoot, "packages/integrations/src"),
	resolve(repoRoot, "packages/api"),
];

/**
 * Raw-dispatch write sites that provably cannot leak a project write. Each
 * entry's justification must say WHY (verified 2026-07-23 five-lens review).
 */
const RAW_WRITE_BOUNDARY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
	[
		"packages/temporal/src/activities/trigger-system.ts",
		"DEAD legacy copy — no importers; the live module (activities/trigger-system/index.ts) resolves the agent's project binding and gates replies",
	],
	[
		"packages/temporal/src/activities/lib/steps/slack-send.ts",
		"Weave slack-send step — gated UPSTREAM at executeWorkflowNode via EXTERNAL_WRITE_NODE_TYPES before the step runs",
	],
	[
		"apps/web/app/api/fabric/tool-router/mcp/route.ts",
		"org-scoped tool-router session (data-analyst agent) — session store carries userId/organizationId only, no project dimension",
	],
	[
		"packages/integrations/src/slack/send-message.ts",
		"shared executor primitive — gating happens at every dispatch call site (chokepoint, integration-handler, reply activities)",
	],
	[
		"packages/integrations/src/channels/slack/index.ts",
		"shared channel adapter primitive — call sites (channel replies) resolve the binding and gate before invoking",
	],
	[
		"apps/web/modules/saas/workflows/lib/plugins/slack/test.ts",
		"calls auth.test only — the chat.postMessage match is a COMMENT about token format",
	],
	[
		"packages/api/modules/workflows/procedures/integrations/test-connection.ts",
		"connection tests call auth.test/read endpoints — the chat.postMessage match is a COMMENT about token format",
	],
]);

describe("MCP external-dispatch read-only gate guard", () => {
	it("every raw Slack chat.postMessage write consults the read-only gate or is a documented no-project boundary", () => {
		const offenders: string[] = [];
		for (const root of RAW_WRITE_SCAN_ROOTS) {
			for (const absFile of walkTsFiles(root)) {
				const content = readFileSync(absFile, "utf-8");
				if (!RAW_SLACK_WRITE_RE.test(content)) {
					continue;
				}
				if (GATE_REF_RE.test(content)) {
					continue;
				}
				const file = relative(repoRoot, absFile).split(sep).join("/");
				if (RAW_WRITE_BOUNDARY_ALLOWLIST.has(file)) {
					continue;
				}
				offenders.push(file);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} file(s) post to Slack (chat.postMessage) without consulting the Read-only gate:\n\n` +
					offenders.map((f) => `  ${f}`).join("\n") +
					"\n\nFix: call `guardToolWriteForReadOnly(projectId, op)` before the post " +
					"(projectId falls back to the ambient activity context). If the site genuinely " +
					"has no project binding, add it to RAW_WRITE_BOUNDARY_ALLOWLIST with a justification.",
			);
		}

		expect(offenders.length).toBe(0);
	});

	it("every web/API MCP tool dispatch routes through the callMcpTool funnel", () => {
		const offenders: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const absFile of walkTsFiles(root)) {
				const content = readFileSync(absFile, "utf-8");
				if (!MCP_CLIENT_RE.test(content)) {
					continue;
				}
				if (!DISPATCH_RE.test(content)) {
					continue;
				}
				if (FUNNEL_RE.test(content)) {
					continue;
				}
				const file = relative(repoRoot, absFile).split(sep).join("/");
				if (ALLOWLIST.has(file)) {
					continue;
				}
				offenders.push(file);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`${offenders.length} file(s) dispatch an MCP tool without the Read-only gate ` +
					"(a write could escape while a project is in Read-only mode):\n\n" +
					offenders.map((f) => `  ${f}`).join("\n") +
					"\n\nFix: route the dispatch through `callMcpTool({ toolName, projectId, execute })` " +
					"from `@repo/mcp`. Do NOT allowlist to silence a real gap.",
			);
		}

		expect(offenders.length).toBe(0);
	});
});
