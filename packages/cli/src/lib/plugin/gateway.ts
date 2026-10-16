/**
 * The plugin carries the project's MCP gateway in its own `.mcp.json`, so a
 * second registration made by an earlier `init` would show an agent two sets
 * of the same tools. This takes the old Claude Code one out.
 *
 * Only an entry in this project's local scope, named exactly as Fabric names
 * it (`fabric-<id suffix>`) and pointing at this project's gateway, is
 * removed: the person's other servers, an organization-wide gateway and a
 * server of another project are never touched. Codex keeps one global list of
 * servers shared by every checkout, which a plugin install in one project is
 * not entitled to edit, so it is left alone and reported.
 */

import { serverNameFor } from "../instructions/agent-mcp.js";
import { inspectServers } from "../instructions/agent-mcp-servers.js";
import type { AgentRunner } from "../instructions/agent-run.js";

const REMOVE_TIMEOUT_MS = 30_000;

export type GatewayRemoval =
	| { kind: "removed"; name: string }
	| { kind: "none" }
	| { kind: "failed"; name: string }
	| { kind: "unchecked" };

export async function removeLocalClaudeGateway(input: {
	run: AgentRunner;
	projectId: string;
	origin: string;
	/** The checkout's top folder, where Claude Code's local scope is the project. */
	cwd: string;
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}): Promise<GatewayRemoval> {
	const name = serverNameFor(input.projectId);
	const inspected = await inspectServers({
		tool: "claude-code",
		origin: input.origin,
		projectId: input.projectId,
		cwd: input.cwd,
		home: input.home,
		env: input.env,
		platform: input.platform,
	});
	if (inspected.state !== "read") {
		return { kind: "unchecked" };
	}
	const ours = inspected.servers.some(
		(server) =>
			server.scope === "local" &&
			server.name === name &&
			server.kind === "this-project",
	);
	if (!ours) {
		return { kind: "none" };
	}
	const removed = await input.run(
		"claude",
		["mcp", "remove", name, "--scope", "local"],
		{ cwd: input.cwd, timeoutMs: REMOVE_TIMEOUT_MS },
	);
	return removed.kind === "exited" && removed.code === 0
		? { kind: "removed", name }
		: { kind: "failed", name };
}
