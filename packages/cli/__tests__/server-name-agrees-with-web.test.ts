/**
 * `fabric instructions init` and the Connect dialog both register a project's
 * MCP server with Codex, which keeps one list of servers for every project on
 * the machine, so each project's server needs a name of its own and the two must
 * choose the same one: `init` and `doctor` look for the name the dialog's
 * command would have written, and the reverse. The rule is in two files that
 * cannot share an import, since this CLI is a published package and cannot
 * depend on the web app:
 *
 *   - `codexServerName` in `packages/cli/src/lib/instructions/agent-mcp.ts`
 *   - `codexServerName` (and the `editorServerName` it is built on) in
 *     `apps/web/modules/saas/projects/components/cli-connection/lib/agent-sign-in.ts`
 *
 * One corpus of project ids runs through both, and the lines `init` prints for
 * Codex are compared with the ones the dialog shows.
 */
import { describe, expect, it } from "vitest";
import {
	buildCodexCommands,
	codexServerName as dialogCodexServerName,
	editorServerName,
	gatewayUrl,
} from "../../../apps/web/modules/saas/projects/components/cli-connection/lib/agent-sign-in.js";
import {
	codexServerName,
	registerAgentMcp,
} from "../src/lib/instructions/agent-mcp.js";
import { simulateAgentTools } from "./helpers/agent-tools.js";

const ORIGIN = "https://deploy.example.com";

/** Ids a project can have: letters, digits, `_` and `-`, one to 64 characters. */
const PROJECT_IDS = [
	"project-example-one",
	"project-checkout-rewrite",
	"cm9x2k4f10000abcd1234",
	"cm0abcdef123456",
	"cm0abcdef654321",
	"Ab_Cd-Ef-12",
	"ab",
	"a",
	"A1",
	"_",
	"---",
	"-_-",
	"0000000",
	"x".repeat(64),
];

/** What the rule gives, written out, on both sides: `agent-sign-in.test.ts` holds the same table. */
const PINNED: Array<[string, string]> = [
	["project-example-one", "fabric-pleone"],
	["cm9x2k4f10000abcd1234", "fabric-cd1234"],
	["Ab_Cd-Ef-12", "fabric-cdef12"],
	["ab", "fabric-ab"],
	["---", "fabric----"],
];

describe("the Codex server name, in the CLI and in the Connect dialog", () => {
	it.each(PROJECT_IDS)("is the same name for the id %s", (id) => {
		expect(codexServerName(id)).toBe(dialogCodexServerName(id));
		expect(codexServerName(id)).toBe(editorServerName("", id));
	});

	it.each(PINNED)(
		"is pinned to the same literal on both sides: %s",
		(id, name) => {
			expect(codexServerName(id)).toBe(name);
			expect(dialogCodexServerName(id)).toBe(name);
		},
	);

	it.each(PROJECT_IDS)(
		"shows the lines `init` prints for Codex, for the id %s",
		async (id) => {
			const { run } = simulateAgentTools({});

			const [result] = await registerAgentMcp({
				tools: ["codex"],
				projectId: id,
				origin: ORIGIN,
				cwd: "/work/checkout",
				home: null,
				env: {},
				platform: process.platform,
				run,
				interactive: false,
			});
			const [add, login] = buildCodexCommands(ORIGIN, id).split("\n");

			expect(result?.registerLine).toBe(add);
			expect(result?.loginLine).toBe(login);
			expect(result?.url).toBe(gatewayUrl(ORIGIN, id));
		},
	);
});
