/**
 * `registerAgentMcp` with the tools' files written as the tools write them and a
 * runner that answers the way each tool's command line does and writes down
 * every call. What is asserted is what the tool was asked, what the person is
 * told, and what was never done: `init` reads what is registered from the files
 * and never asks a tool, since a tool's `get` and `list` start the servers they
 * name and one of them can be the repository's own.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	agentMcpLines,
	codexServerName,
	registerAgentMcp,
	serverNameFor,
} from "../src/lib/instructions/agent-mcp.js";
import { NO_LINE_FOR_ADDRESS } from "../src/lib/shell-words.js";
import {
	type ClaudeEntry,
	codexTable,
	removeToolFiles,
	SECRET,
	simulateAgentTools,
	type Tools,
	toolFiles,
	verbs,
	writeClaudeFiles,
	writeCodexConfig,
} from "./helpers/agent-tools.js";

const NAME = "fabric-pleone";
const ORIGIN = "https://deploy.example.com";
const PROJECT = "project-example-one";
const OTHER_PROJECT = "project-example-two";
const url = (origin: string, project = PROJECT) =>
	`${origin}/api/mcp-gateway/projects/${project}`;
const URL = url(ORIGIN);
const OTHER_URL = url(ORIGIN, OTHER_PROJECT);
const OTHER_DEPLOYMENT_URL = url("https://elsewhere.example.org");
const FOREIGN_URL = "https://mcp.vendor.example.net/mcp";

afterEach(removeToolFiles);

interface State {
	/** What Claude Code's files hold under the name `fabric`. */
	claude?: ClaudeEntry[];
	/** What Codex's `config.toml` holds, as written. */
	codex?: string;
	/** `.claude.json` that is not JSON. */
	claudeUnreadable?: boolean;
}

async function register(
	tools: Tools,
	options: {
		state?: State;
		tools?: Array<"claude-code" | "codex">;
		interactive?: boolean;
		origin?: string;
		checkSignIn?: boolean;
	} = {},
) {
	const files = await toolFiles();
	const state = options.state ?? {};
	if (state.claudeUnreadable) {
		await writeFile(path.join(files.home, ".claude.json"), "{ not json");
	} else if (state.claude !== undefined) {
		await writeClaudeFiles(
			files,
			state.claude.map((entry) => ({ name: NAME, ...entry })),
		);
	}
	if (state.codex !== undefined) {
		await writeCodexConfig(files, state.codex);
	}
	const { run, calls, statusCalls } = simulateAgentTools(tools, files);
	const results = await registerAgentMcp({
		...(options.checkSignIn === undefined
			? {}
			: { checkSignIn: options.checkSignIn }),
		tools: options.tools ?? ["claude-code"],
		projectId: PROJECT,
		origin: options.origin ?? ORIGIN,
		cwd: files.cwd,
		home: files.home,
		env: files.env,
		platform: process.platform,
		run,
		interactive: options.interactive ?? false,
	});
	return {
		results,
		calls,
		statusCalls,
		lines: agentMcpLines(results),
		files,
	};
}

const ADD_CLAUDE = [
	"mcp",
	"add",
	"--scope",
	"local",
	"--transport",
	"http",
	"fabric-pleone",
	URL,
];

describe("codexServerName", () => {
	it("is fabric- and the last six letters and digits of the project id", () => {
		expect(codexServerName("project-example-one")).toBe("fabric-pleone");
		expect(codexServerName("cm9x2k4f10000abcd1234")).toBe("fabric-cd1234");
		expect(codexServerName("Ab_Cd-Ef-12")).toBe("fabric-cdef12");
		expect(codexServerName("ab")).toBe("fabric-ab");
	});

	it("agrees with the name the web app gives an editor server that has no project name to slug", () => {
		// The web app's `editorServerName("", id)` pins these two values in
		// agent-sign-in.test.ts; this CLI cannot import it, so each side holds
		// the same literals.
		expect(codexServerName("project-example-one")).toBe("fabric-pleone");
		expect(codexServerName("---")).toBe("fabric----");
	});

	it("differs between two projects, however alike their ids start", () => {
		expect(codexServerName("cm9x2k4f10000aaaaaa123456")).not.toBe(
			codexServerName("cm9x2k4f10000aaaaaa654321"),
		);
	});

	it("keeps Claude Code's server for a project under the one name", () => {
		expect(serverNameFor(PROJECT)).toBe("fabric-pleone");
		expect(serverNameFor(PROJECT)).toBe("fabric-pleone");
	});
});

describe("registerAgentMcp for Claude Code", () => {
	it.each(["user", "local"] as const)(
		"leaves the organization-wide server in the %s scope as it is, adds the project's and says so",
		async (scope) => {
			const { results, calls, lines } = await register(
				{},
				{
					state: {
						claude: [
							{
								scope,
								url: `${ORIGIN}/api/mcp-gateway/`,
								name: "fabric",
							},
						],
					},
				},
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(calls[0]?.args).toEqual(ADD_CLAUDE);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
			expect(lines).toContain(
				'Your organization-wide Fabric server "fabric" stays as it is; coding instructions use the project server "fabric-pleone".',
			);
		},
	);

	it("counts a legacy `fabric` at this URL as registered and adds nothing", async () => {
		const { results, calls, lines } = await register(
			{},
			{
				state: {
					claude: [{ scope: "local", url: URL, name: "fabric" }],
				},
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
		expect(results[0]?.name).toBe("fabric");
		expect(lines[0]).toBe(
			'The Fabric MCP server is already registered for Claude Code as "fabric".',
		);
	});

	it.each([
		["a trailing slash", `${URL}/`],
		[
			"capitals in the scheme and host",
			URL.replace("https://deploy", "HTTPS://Deploy"),
		],
		["an explicit default port", URL.replace(".com", ".com:443")],
		["an empty query and fragment", `${URL}/?#`],
	])(
		"counts a legacy `fabric` spelled with %s as this project's",
		async (_label, spelled) => {
			const { results, calls } = await register(
				{},
				{
					state: {
						claude: [
							{ scope: "local", url: spelled, name: "fabric" },
						],
					},
				},
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: "already" });
		},
	);

	it.each([
		[
			"another host that only adds www",
			URL.replace("//deploy", "//www.deploy"),
		],
		["a query", `${URL}?a=1`],
		["a path below the project", `${URL}/extra`],
	])(
		"does not take %s for this project's gateway",
		async (_label, spelled) => {
			const { results, calls } = await register(
				{},
				{
					state: {
						claude: [
							{ scope: "local", url: spelled, name: "fabric" },
						],
					},
				},
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
		},
	);

	it.each([
		["another project's", OTHER_URL],
		[
			"another project's, spelled with a trailing slash and capitals",
			`${OTHER_URL.replace("deploy", "DEPLOY")}/`,
		],
	])(
		"replaces this deployment's own legacy `fabric` for %s gateway",
		async (_label, stale) => {
			const { results, calls } = await register(
				{},
				{
					state: {
						claude: [
							{ scope: "local", url: stale, name: "fabric" },
						],
					},
				},
			);

			expect(verbs(calls)).toEqual([
				"claude mcp remove",
				"claude mcp add",
			]);
			expect(calls[0]?.args).toEqual([
				"mcp",
				"remove",
				"fabric",
				"--scope",
				"local",
			]);
			expect(calls[1]?.args).toEqual(ADD_CLAUDE);
			expect(results[0]?.outcome).toEqual({ kind: "replaced" });
		},
	);

	it.each([
		["a command", null],
		["another host", FOREIGN_URL],
		["another deployment", OTHER_DEPLOYMENT_URL],
	])(
		"never touches a local `fabric` that is %s, and still registers the project's own name",
		async (_label, foreign) => {
			const { results, calls, lines } = await register(
				{},
				{
					state: {
						claude: [
							{ scope: "local", url: foreign, name: "fabric" },
						],
					},
				},
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(calls[0]?.args).toEqual(ADD_CLAUDE);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
			expect(lines[0]).toBe(
				'Registered the Fabric MCP server for Claude Code as "fabric-pleone".',
			);
		},
	);

	it("is already registered on the second run beside a foreign `fabric`", async () => {
		const { results, calls } = await register(
			{},
			{
				state: {
					claude: [
						{ scope: "local", url: null, name: "fabric" },
						{ scope: "local", url: URL },
					],
				},
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
	});

	it("adds the project's gateway in the checkout's own scope when there is no server of that name", async () => {
		const { results, calls, lines, files } = await register({});

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(calls[0]?.args).toEqual(ADD_CLAUDE);
		expect(calls.every((call) => call.cwd === files.cwd)).toBe(true);
		expect(results[0]).toMatchObject({
			tool: "claude-code",
			name: "fabric-pleone",
			url: URL,
			outcome: { kind: "registered" },
			login: "printed",
			registerLine: `claude ${ADD_CLAUDE.join(" ")}`,
			loginLine: "claude mcp login fabric-pleone",
		});
		expect(lines).toEqual([
			'Registered the Fabric MCP server for Claude Code as "fabric-pleone".',
			"To finish, sign Claude Code in to it: claude mcp login fabric-pleone",
		]);
	});

	it("does nothing when the same URL is already registered", async () => {
		const { results, calls, lines } = await register(
			{},
			{ state: { claude: [{ scope: "local", url: URL }] } },
		);

		expect(calls).toEqual([]);
		expect(results[0]).toMatchObject({
			outcome: { kind: "already" },
			login: "printed",
			status: "needs-sign-in",
		});
		expect(lines).toEqual([
			"The Fabric MCP server is already registered for Claude Code.",
			"To finish, sign Claude Code in to it: claude mcp login fabric-pleone",
		]);
	});

	it("does not remove and add a local server whose URL only differs in spelling", async () => {
		const { results, calls } = await register(
			{},
			{ state: { claude: [{ scope: "local", url: `${URL}/` }] } },
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
	});

	it.each(["user", "project"] as const)(
		"does nothing when the same URL is registered in the %s scope",
		async (scope) => {
			const { results, calls } = await register(
				{},
				{ state: { claude: [{ scope, url: URL }] } },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: "already" });
		},
	);

	it("replaces a server of ours that is for another project, in the checkout's own scope", async () => {
		const { results, calls, lines } = await register(
			{},
			{ state: { claude: [{ scope: "local", url: OTHER_URL }] } },
		);

		expect(verbs(calls)).toEqual(["claude mcp remove", "claude mcp add"]);
		expect(calls[0]?.args).toEqual([
			"mcp",
			"remove",
			"fabric-pleone",
			"--scope",
			"local",
		]);
		expect(calls[1]?.args).toEqual(ADD_CLAUDE);
		expect(results[0]?.outcome).toEqual({ kind: "replaced" });
		expect(lines[0]).toBe(
			'Replaced the Fabric MCP server "fabric-pleone" in Claude Code with this project\'s.',
		);
	});

	it.each(["user", "project"] as const)(
		"registers the checkout's own server over one of ours in the %s scope, and says it takes precedence",
		async (scope) => {
			const { results, calls, lines } = await register(
				{},
				{ state: { claude: [{ scope, url: OTHER_URL }] } },
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(calls[0]?.args).toEqual(ADD_CLAUDE);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
			expect(lines[0]).toBe(
				'Registered the Fabric MCP server for Claude Code as "fabric-pleone".',
			);
			expect(lines[1]).toBe(
				`Claude Code also has a "fabric-pleone" server in your ${scope} settings (${new globalThis.URL(OTHER_URL).host}); in this checkout the project's gateway takes precedence.`,
			);
		},
	);

	it.each([
		["user", FOREIGN_URL, "mcp.vendor.example.net"],
		["project", FOREIGN_URL, "mcp.vendor.example.net"],
		["user", OTHER_DEPLOYMENT_URL, "elsewhere.example.org"],
		["project", null, "a local command"],
	] as const)(
		"registers the checkout's own server despite a foreign one in the %s scope (%s)",
		async (scope, serverUrl, points) => {
			const { results, calls, lines } = await register(
				{},
				{ state: { claude: [{ scope, url: serverUrl }] } },
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
			expect(lines).toContain(
				`Claude Code also has a "fabric-pleone" server in your ${scope} settings (${points}); in this checkout the project's gateway takes precedence.`,
			);
		},
	);

	it.each([
		["another vendor's server", FOREIGN_URL, "mcp.vendor.example.net"],
		[
			"a gateway of another deployment",
			OTHER_DEPLOYMENT_URL,
			"elsewhere.example.org",
		],
		["a server with no URL", null, "a local command"],
	])(
		"leaves %s in the checkout's local scope alone",
		async (_label, serverUrl, points) => {
			const { results, calls, lines } = await register(
				{},
				{ state: { claude: [{ scope: "local", url: serverUrl }] } },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({
				kind: "left",
				scope: "local",
				points,
			});
			expect(results[0]?.login).toBe("unneeded");
			expect(lines).toEqual([
				`Claude Code already has a server named "fabric-pleone" in this checkout's local settings that points at ${points}, not at this project's gateway, so it was left alone. Remove it, then run: claude ${ADD_CLAUDE.join(" ")}`,
			]);
		},
	);

	it("replaces the checkout's own entry of ours and notes a foreign one in the user scope", async () => {
		const { results, calls, lines } = await register(
			{},
			{
				state: {
					claude: [
						{ scope: "local", url: OTHER_URL },
						{ scope: "user", url: FOREIGN_URL },
					],
				},
			},
		);

		expect(verbs(calls)).toEqual(["claude mcp remove", "claude mcp add"]);
		expect(results[0]?.outcome).toEqual({ kind: "replaced" });
		expect(lines).toContain(
			'Claude Code also has a "fabric-pleone" server in your user settings (mcp.vendor.example.net); in this checkout the project\'s gateway takes precedence.',
		);
	});

	it("registers locally when a higher-precedence entry points elsewhere and only a lower one is at this URL", async () => {
		const { results, calls, lines } = await register(
			{},
			{
				state: {
					claude: [
						{ scope: "project", url: FOREIGN_URL },
						{ scope: "user", url: URL },
					],
				},
			},
		);

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.outcome).toEqual({ kind: "registered" });
		expect(lines).toContain(
			'Claude Code also has a "fabric-pleone" server in your project settings (mcp.vendor.example.net); in this checkout the project\'s gateway takes precedence.',
		);
	});

	it("is already registered when the winning entry is ours, whatever sits below it", async () => {
		const { results, calls } = await register(
			{},
			{
				state: {
					claude: [
						{ scope: "project", url: URL },
						{ scope: "user", url: FOREIGN_URL },
					],
				},
			},
		);

		expect(calls.filter((call) => call.args[1] === "add")).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
	});

	it("says the tool is not there, with the line to run once it is", async () => {
		const { results, calls, lines } = await register({ claude: "missing" });

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.outcome).toEqual({ kind: "skipped" });
		expect(lines).toEqual([
			`Skipped the Claude Code MCP server: claude is not on PATH. Once it is, run: claude ${ADD_CLAUDE.join(" ")}`,
		]);
	});

	it("writes nothing when it cannot tell what is registered", async () => {
		const { results, calls, lines } = await register(
			{},
			{ state: { claudeUnreadable: true } },
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "failed" });
		expect(lines).toEqual([
			`Could not register the Fabric MCP server for Claude Code. Run: claude ${ADD_CLAUDE.join(" ")}`,
		]);
	});

	it("does not add after a removal that failed", async () => {
		const { results, calls } = await register(
			{ claudeRemove: "fails" },
			{ state: { claude: [{ scope: "local", url: OTHER_URL }] } },
		);

		expect(verbs(calls)).toEqual(["claude mcp remove"]);
		expect(results[0]?.outcome).toEqual({ kind: "failed" });
	});

	it("reports a failed add with the line to run, and no sign-in", async () => {
		const { results, lines } = await register(
			{ claudeAdd: "fails" },
			{ interactive: true },
		);

		expect(results[0]).toMatchObject({
			outcome: { kind: "failed" },
			login: "unneeded",
		});
		expect(lines).toEqual([
			`Could not register the Fabric MCP server for Claude Code. Run: claude ${ADD_CLAUDE.join(" ")}`,
		]);
	});

	it("bounds the write in time and asks nothing of the person except for the sign-in", async () => {
		const { calls } = await register({});

		expect(calls.map((call) => call.timeoutMs)).toEqual([20_000]);
		expect(calls.some((call) => call.interactive)).toBe(false);
	});
});

describe("registerAgentMcp for Codex", () => {
	const ADD_CODEX = ["mcp", "add", "fabric-pleone", "--url", URL];

	it("adds the project's gateway under its own name, with the terminal, which is also how Codex signs in", async () => {
		const { results, calls, lines, files } = await register(
			{},
			{ tools: ["codex"], interactive: true },
		);

		expect(verbs(calls)).toEqual(["codex mcp add"]);
		expect(calls[0]).toMatchObject({
			args: ADD_CODEX,
			cwd: files.cwd,
			interactive: true,
			timeoutMs: 5 * 60_000,
		});
		expect(results[0]).toMatchObject({
			tool: "codex",
			name: "fabric-pleone",
			outcome: { kind: "registered" },
			login: "completed",
			registerLine: `codex ${ADD_CODEX.join(" ")}`,
			loginLine: "codex mcp login fabric-pleone",
		});
		expect(lines).toEqual([
			'Registered the Fabric MCP server for Codex as "fabric-pleone".',
		]);
	});

	it("never runs a login after the add, since the add signed in", async () => {
		const { calls } = await register(
			{ login: "ok" },
			{ tools: ["codex"], interactive: true },
		);

		expect(calls.filter((call) => call.args[1] === "login")).toEqual([]);
	});

	describe("with nobody at the terminal", () => {
		it.each([
			["a machine that has nothing registered", {}],
			[
				"a server of ours for another project",
				{ codex: codexTable("fabric-pleone", OTHER_URL) },
			],
		] as Array<[string, State]>)(
			"does not run the add at all, which would wait for a browser, for %s",
			async (_label, state) => {
				const { results, calls, lines } = await register(
					{ codexAdd: "blocks" },
					{ tools: ["codex"], state, interactive: false },
				);

				expect(calls).toEqual([]);
				expect(results[0]).toMatchObject({
					outcome: { kind: "manual" },
					login: "unneeded",
					registerLine: `codex ${ADD_CODEX.join(" ")}`,
				});
				expect(lines).toEqual([
					`Codex signs in as part of adding the Fabric MCP server, which opens your browser and waits for you, so init did not run it. Run: codex ${ADD_CODEX.join(" ")}`,
				]);
			},
		);

		it("says the same when the tool is not installed, since nothing was run to find out", async () => {
			const { results, calls } = await register(
				{ codex: "missing" },
				{ tools: ["codex"], interactive: false },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: "manual" });
		});

		it("is told in a fixed sentence, with no line, when the address cannot be written into one", async () => {
			const { lines } = await register(
				{},
				{
					tools: ["codex"],
					interactive: false,
					origin: "https://a.example.com$(id).x",
				},
			);

			expect(lines).toEqual([
				`Codex signs in as part of adding the Fabric MCP server, which opens your browser and waits for you, so init did not run it. ${NO_LINE_FOR_ADDRESS}`,
			]);
		});
	});

	describe("at a terminal, when the add does not finish", () => {
		it.each([
			["is cut off while it waits for the sign-in", "blocks"],
			["exits non-zero after it registered the server", "signin-fails"],
		] as const)(
			"reports the server as registered and not signed in, with the login line, when the add %s",
			async (_label, codexAdd) => {
				const { results, calls, lines } = await register(
					{ codexAdd },
					{ tools: ["codex"], interactive: true },
				);

				expect(verbs(calls)).toEqual(["codex mcp add"]);
				expect(results[0]).toMatchObject({
					outcome: { kind: "registered" },
					login: "not-finished",
				});
				expect(lines).toEqual([
					'Registered the Fabric MCP server for Codex as "fabric-pleone".',
					"The Codex sign-in did not finish. Run: codex mcp login fabric-pleone",
				]);
			},
		);

		it("says the server was replaced, and not signed in, when it replaced another project's", async () => {
			const { results, lines } = await register(
				{ codexAdd: "signin-fails" },
				{
					tools: ["codex"],
					interactive: true,
					state: { codex: codexTable("fabric-pleone", OTHER_URL) },
				},
			);

			expect(results[0]).toMatchObject({
				outcome: { kind: "replaced" },
				login: "not-finished",
			});
			expect(lines).toEqual([
				'Replaced the Fabric MCP server "fabric-pleone" in Codex with this project\'s.',
				"The Codex sign-in did not finish. Run: codex mcp login fabric-pleone",
			]);
		});

		it("reports a failure, with the add line, when the add registered nothing", async () => {
			const { results, lines } = await register(
				{ codexAdd: "fails" },
				{ tools: ["codex"], interactive: true },
			);

			expect(results[0]?.outcome).toEqual({ kind: "failed" });
			expect(lines).toEqual([
				`Could not register the Fabric MCP server for Codex. Run: codex ${ADD_CODEX.join(" ")}`,
			]);
		});
	});

	it("does nothing when the gateway is already registered, whatever the person named it", async () => {
		const { results, calls, lines } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("my-fabric", URL) },
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]).toMatchObject({
			name: "my-fabric",
			expectedName: "fabric-pleone",
			outcome: { kind: "already" },
			login: "hint",
		});
		expect(lines).toEqual([
			'The Fabric MCP server is already registered for Codex as "my-fabric".',
			"If Codex has not signed in to it yet, run: codex mcp login my-fabric",
		]);
	});

	it("replaces the name's server when it is another project's gateway of this deployment", async () => {
		const { results, calls } = await register(
			{},
			{
				tools: ["codex"],
				interactive: true,
				state: { codex: codexTable("fabric-pleone", OTHER_URL) },
			},
		);

		expect(verbs(calls)).toEqual(["codex mcp add"]);
		expect(calls[0]?.args).toEqual(ADD_CODEX);
		expect(results[0]?.outcome).toEqual({ kind: "replaced" });
	});

	it.each([
		["another vendor's server", FOREIGN_URL],
		["a gateway of another deployment", OTHER_DEPLOYMENT_URL],
		["a server with no URL", null],
	])("leaves %s of that name alone", async (_label, serverUrl) => {
		const { results, calls, lines } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("fabric-pleone", serverUrl) },
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toMatchObject({
			kind: "left",
			scope: null,
		});
		expect(lines).toEqual([
			expect.stringMatching(
				/^Codex already has a server named "fabric-pleone" in its settings that points at .+, not at this project's gateway, so it was left alone. Remove it, then run: codex /,
			),
		]);
	});

	it("leaves the person's other servers where they are", async () => {
		const { calls } = await register(
			{},
			{
				tools: ["codex"],
				interactive: true,
				state: {
					codex: `model = "gpt"\n\n${codexTable("docs", FOREIGN_URL)}`,
				},
			},
		);

		expect(verbs(calls)).toEqual(["codex mcp add"]);
	});

	it("reads a server's own sub-tables as part of it, not as another server", async () => {
		const { results, calls } = await register(
			{},
			{
				tools: ["codex"],
				interactive: true,
				state: {
					codex: `${codexTable("docs", FOREIGN_URL)}\n[mcp_servers.docs.env]\nTOKEN = "x"\n`,
				},
			},
		);

		expect(verbs(calls)).toEqual(["codex mcp add"]);
		expect(results[0]?.outcome).toEqual({ kind: "registered" });
	});

	it.each([
		[
			"an inline table",
			`mcp_servers = { fabric-pleone = { url = "${FOREIGN_URL}" } }\n`,
		],
		["a dotted key", `mcp_servers.fabric-pleone.url = "${FOREIGN_URL}"\n`],
		["a table of all of them", "[mcp_servers]\nfoo = 1\n"],
		[
			"a table spelled with spaces",
			`[ mcp_servers . fabric-pleone ]\nurl = "${FOREIGN_URL}"\n`,
		],
		["an array of tables", `[[mcp_servers]]\nname = "fabric-pleone"\n`],
	])(
		"writes nothing when a server is written as %s, which a missed name could be replaced under",
		async (_label, codex) => {
			const { results, calls } = await register(
				{},
				{ tools: ["codex"], state: { codex } },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: "failed" });
		},
	);

	it("says the tool is not there", async () => {
		const { results, lines } = await register(
			{ codex: "missing" },
			{ tools: ["codex"], interactive: true },
		);

		expect(results[0]?.outcome).toEqual({ kind: "skipped" });
		expect(lines).toEqual([
			`Skipped the Codex MCP server: codex is not on PATH. Once it is, run: codex ${ADD_CODEX.join(" ")}`,
		]);
	});

	it("says a Codex server that was registered before may not be signed in, and never signs it in itself", async () => {
		const { results, calls, lines } = await register(
			{ login: "ok" },
			{
				tools: ["codex"],
				interactive: true,
				state: { codex: codexTable("fabric-pleone", URL) },
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]).toMatchObject({
			outcome: { kind: "already" },
			login: "hint",
			loginLine: "codex mcp login fabric-pleone",
		});
		expect(lines).toEqual([
			"The Fabric MCP server is already registered for Codex.",
			"If Codex has not signed in to it yet, run: codex mcp login fabric-pleone",
		]);
	});

	it("gives the hint under the name the person registered it by", async () => {
		const { lines } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("my-fabric", URL) },
			},
		);

		expect(lines).toEqual([
			'The Fabric MCP server is already registered for Codex as "my-fabric".',
			"If Codex has not signed in to it yet, run: codex mcp login my-fabric",
		]);
	});

	it("gives no hint for a name that cannot be written into a line", async () => {
		const { results, lines } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("my fabric", URL) },
			},
		);

		expect(results[0]?.login).toBe("unneeded");
		expect(lines).toEqual([
			'The Fabric MCP server is already registered for Codex as "(a name with unusual characters)".',
		]);
	});
});

describe("registerAgentMcp's sign-in", () => {
	it("hands the terminal to the tool's own login for a server it just registered", async () => {
		const { results, calls, lines, files } = await register(
			{ login: "ok" },
			{ interactive: true },
		);

		const login = calls.at(-1);
		expect(login).toMatchObject({
			command: "claude",
			args: ["mcp", "login", "fabric-pleone"],
			cwd: files.cwd,
			interactive: true,
			timeoutMs: 5 * 60_000,
		});
		expect(results[0]?.login).toBe("completed");
		expect(lines).toEqual([
			'Registered the Fabric MCP server for Claude Code as "fabric-pleone".',
		]);
	});

	it("also signs in a server it replaced", async () => {
		const { results, calls } = await register(
			{ login: "ok" },
			{
				interactive: true,
				state: { claude: [{ scope: "local", url: OTHER_URL }] },
			},
		);

		expect(verbs(calls).at(-1)).toBe("claude mcp login");
		expect(results[0]?.login).toBe("completed");
	});

	it("prints the line to run when nobody is at the terminal, and runs nothing", async () => {
		const { results, calls } = await register({}, { interactive: false });

		expect(verbs(calls)).not.toContain("claude mcp login");
		expect(results[0]?.login).toBe("printed");
	});

	it.each([
		["a sign-in that exits non-zero", "fails"],
		["a sign-in that runs out of time", "timed-out"],
	] as const)(
		"prints the line to run after %s, and still reports the registration",
		async (_label, login) => {
			const { results, lines } = await register(
				{ login },
				{ interactive: true },
			);

			expect(results[0]).toMatchObject({
				outcome: { kind: "registered" },
				login: "not-finished",
			});
			expect(lines).toEqual([
				'Registered the Fabric MCP server for Claude Code as "fabric-pleone".',
				"The Claude Code sign-in did not finish. Run: claude mcp login fabric-pleone",
			]);
		},
	);

	it.each<[string, State]>([
		["already registered", { claude: [{ scope: "local", url: URL }] }],
		["left alone", { claude: [{ scope: "local", url: FOREIGN_URL }] }],
	])("does not sign in a server that was %s", async (_label, state) => {
		const { calls } = await register(
			{ login: "ok" },
			{ state, interactive: true },
		);

		expect(verbs(calls)).not.toContain("claude mcp login");
	});

	it("does not sign in a server whose tool is not installed", async () => {
		const { calls } = await register(
			{ claude: "missing", login: "ok" },
			{ interactive: true },
		);

		expect(verbs(calls)).not.toContain("claude mcp login");
	});

	it("signs Claude Code in with its login and Codex in with its add, and runs no second login for Codex", async () => {
		const { results, calls } = await register(
			{ login: "ok" },
			{ tools: ["claude-code", "codex"], interactive: true },
		);

		expect(
			calls.map((call) => `${call.command} ${call.args.join(" ")}`),
		).toEqual([
			`claude ${ADD_CLAUDE.join(" ")}`,
			`codex mcp add fabric-pleone --url ${URL}`,
			"claude mcp login fabric-pleone",
		]);
		expect(results.map((result) => result.login)).toEqual([
			"completed",
			"completed",
		]);
	});

	it("keeps one tool's failure from stopping the other", async () => {
		const { results } = await register(
			{ claude: "missing" },
			{ tools: ["claude-code", "codex"] },
		);

		expect(results.map((result) => result.outcome.kind)).toEqual([
			"skipped",
			"manual",
		]);
	});

	it("says a Claude Code server that was registered before needs a sign-in, and never signs it in itself", async () => {
		const { results, calls, lines } = await register(
			{ login: "ok" },
			{
				interactive: true,
				state: { claude: [{ scope: "local", url: URL }] },
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]).toMatchObject({
			outcome: { kind: "already" },
			login: "printed",
			loginLine: "claude mcp login fabric-pleone",
		});
		expect(lines).toEqual([
			"The Fabric MCP server is already registered for Claude Code.",
			"To finish, sign Claude Code in to it: claude mcp login fabric-pleone",
		]);
	});

	it.each(["disconnected", "reconnected", "not-connected"] as const)(
		"does not read a %s server as signed in",
		async (claudeStatus) => {
			const { results } = await register(
				{ claudeStatus },
				{ state: { claude: [{ scope: "local", url: URL }] } },
			);

			expect(results[0]?.login).toBe("hint");
		},
	);

	it("does not ask Claude Code about its sign-in when the caller says not to", async () => {
		const { results, statusCalls } = await register(
			{ claudeStatus: "connected" },
			{
				checkSignIn: false,
				state: { claude: [{ scope: "local", url: URL }] },
			},
		);

		expect(statusCalls).toEqual([]);
		expect(results[0]?.login).toBe("hint");
	});

	it("treats a Codex server at the same address spelled differently as already registered", async () => {
		const { results, calls } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("fabric-pleone", `${URL}/`) },
			},
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
	});

	it("gives the sign-in line for a server found in another scope too", async () => {
		const { lines } = await register(
			{},
			{ state: { claude: [{ scope: "user", url: URL }] } },
		);

		expect(lines).toEqual([
			"The Fabric MCP server is already registered for Claude Code.",
			"To finish, sign Claude Code in to it: claude mcp login fabric-pleone",
		]);
	});
});

describe("registerAgentMcp never asks a tool what it holds", () => {
	const SCENARIOS: Array<[string, Tools, State]> = [
		["an empty machine", {}, {}],
		[
			"our own server, up to date",
			{},
			{ claude: [{ scope: "local", url: URL }] },
		],
		[
			"our own server, for another project",
			{},
			{ claude: [{ scope: "local", url: OTHER_URL }] },
		],
		[
			"a repository's own server that runs a command, in its .mcp.json",
			{},
			{ claude: [{ scope: "project", url: null }] },
		],
		[
			"another vendor's server in every scope",
			{},
			{
				claude: [
					{ scope: "local", url: FOREIGN_URL },
					{ scope: "user", url: FOREIGN_URL },
					{ scope: "project", url: FOREIGN_URL },
				],
			},
		],
		[
			"a tool that is not installed",
			{ claude: "missing", codex: "missing" },
			{},
		],
		["a configuration that cannot be read", {}, { claudeUnreadable: true }],
	];

	it.each(SCENARIOS)(
		"runs only add, remove and login: %s",
		async (_label, tools, state) => {
			const { calls } = await register(tools, {
				state,
				tools: ["claude-code", "codex"],
				interactive: true,
			});

			for (const call of calls) {
				expect(["add", "remove", "login"]).toContain(call.args[1]);
			}
		},
	);

	it("registers over a project-scope server that runs a command, without starting anything to look at it", async () => {
		const { results, calls } = await register(
			{},
			{ state: { claude: [{ scope: "project", url: null }] } },
		);

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.shadowed).toEqual([
			{ scope: "project", points: "a local command" },
		]);
	});
});

describe("what a run prints", () => {
	it("never carries what a tool's files hold about a server, including its headers", async () => {
		const scenarios: Array<[Tools, State]> = [
			[{}, {}],
			[{}, { claude: [{ scope: "local", url: URL }] }],
			[{}, { claude: [{ scope: "local", url: OTHER_URL }] }],
			[{}, { claude: [{ scope: "user", url: FOREIGN_URL }] }],
			[{}, { claude: [{ scope: "project", url: null }] }],
			[{ claudeAdd: "fails" }, {}],
			[{}, { claudeUnreadable: true }],
			[
				{ codexAdd: "fails" },
				{ codex: codexTable("fabric-pleone", FOREIGN_URL) },
			],
			[{}, { codex: codexTable("my-fabric", URL) }],
		];

		for (const [tools, state] of scenarios) {
			const { results, lines } = await register(tools, {
				state,
				tools: ["claude-code", "codex"],
				interactive: true,
			});
			const printed = JSON.stringify({ results, lines });

			expect(printed).not.toContain(SECRET);
			expect(printed).not.toContain("Bearer");
		}
	});

	it("shows a Codex server's name only when it is a plain one", async () => {
		const bidiOverride = String.fromCharCode(0x202e);
		const hostile = `evil\u001b[2J name${bidiOverride}`;
		const { results, lines } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable(hostile, URL) },
			},
		);

		const printed = JSON.stringify({ results, lines });
		expect(results[0]?.outcome).toEqual({ kind: "already" });
		expect(results[0]?.name).toBe("(a name with unusual characters)");
		expect(lines).toEqual([
			'The Fabric MCP server is already registered for Codex as "(a name with unusual characters)".',
		]);
		expect(printed).not.toContain("evil");
		expect(printed).not.toContain("\u001b");
		expect(printed).not.toContain("\\u001b");
		expect(printed).not.toContain(bidiOverride);
	});

	it.each([
		["a name with a space", "my fabric"],
		["a name with a dot", "fabric.one"],
		["a name that is too long", "a".repeat(65)],
	])("does not repeat %s", async (_label, name) => {
		const { results } = await register(
			{},
			{ tools: ["codex"], state: { codex: codexTable(name, URL) } },
		);

		expect(results[0]?.name).toBe("(a name with unusual characters)");
	});

	it("never gives the sign-in line a name that is not plain", async () => {
		const { results } = await register(
			{},
			{
				tools: ["codex"],
				state: { codex: codexTable("my fabric", URL) },
			},
		);

		expect(results[0]?.loginLine).toBeNull();
	});
});

describe("a deployment address that cannot be written into a command", () => {
	const ADDRESSES = [
		"https://a.example.com$(id).x",
		"https://a.example.com&calc.exe",
		"https://a.example.com;ls",
		"https://a.example.com`id`",
		"https://a.example.com'x",
		'https://a.example.com"x',
		"https://a.example.com!x",
		"https://a.example.com~x",
		"https://a.example.com,x",
		"https://a.example.com{x}",
		"http://[::1]:3001",
	];

	const REPEATS = [
		"$(id)",
		"&calc",
		";ls",
		"`id`",
		"'x",
		'"x',
		"!x",
		"~x",
		",x",
		"{x}",
		"[::1]",
	];

	it.each(ADDRESSES)(
		"is never written into a line the person is told to run: %s",
		async (address) => {
			const scenarios: Array<[Tools, State]> = [
				[{}, {}],
				[{ claude: "missing" }, {}],
				[{ claudeAdd: "fails" }, {}],
				[{}, { claude: [{ scope: "local", url: FOREIGN_URL }] }],
				[
					{},
					{
						claude: [
							{ scope: "user", url: url(address, OTHER_PROJECT) },
						],
					},
				],
				[
					{},
					{
						claude: [
							{
								scope: "local",
								url: url(address, OTHER_PROJECT),
							},
						],
					},
				],
			];

			for (const [tools, state] of scenarios) {
				const { results, lines } = await register(tools, {
					state,
					tools: ["claude-code", "codex"],
					interactive: true,
					origin: address,
				});

				const told = JSON.stringify({
					lines,
					lineFields: results.map((result) => [
						result.registerLine,
						result.loginLine,
					]),
				});
				for (const repeated of REPEATS) {
					expect(told).not.toContain(repeated);
				}
				expect(told).not.toContain("a.example.com");
				for (const result of results) {
					expect(result.registerLine).toBeNull();
					expect(["registered", "replaced"]).not.toContain(
						result.outcome.kind,
					);
				}
			}
		},
	);

	it("is said in a fixed sentence instead of the line, for every outcome that would have printed one", async () => {
		const address = "https://a.example.com$(id).x";

		const absent = await register({}, { origin: address });
		const skipped = await register(
			{ claude: "missing" },
			{ origin: address },
		);
		const foreign = await register(
			{},
			{
				origin: address,
				state: { claude: [{ scope: "local", url: FOREIGN_URL }] },
			},
		);

		expect(absent.lines).toEqual([
			`Could not register the Fabric MCP server for Claude Code. ${NO_LINE_FOR_ADDRESS}`,
		]);
		expect(skipped.lines).toEqual([
			`Skipped the Claude Code MCP server: claude is not on PATH. Once it is, ${NO_LINE_FOR_ADDRESS}`,
		]);
		expect(foreign.lines).toEqual([
			`Claude Code already has a server named "fabric-pleone" in this checkout's local settings that points at mcp.vendor.example.net, not at this project's gateway, so it was left alone. Remove it, then ${NO_LINE_FOR_ADDRESS}`,
		]);
	});

	it("still lets the tool's own sign-in line print, which carries no address", async () => {
		const { results } = await register(
			{},
			{ origin: "https://a.example.com$(id).x", tools: ["codex"] },
		);

		expect(results[0]?.loginLine).toBe("codex mcp login fabric-pleone");
	});
});
