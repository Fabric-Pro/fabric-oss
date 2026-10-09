/**
 * `init` and `doctor` read every server a tool holds, whatever it is named, and
 * classify each by where it points: this project's gateway, another project's,
 * the organization-wide one, someone else's, or a command. These tests write
 * those files with servers under names `init` did not choose and show what a run
 * does with each: finds its own, replaces only its own stale ones, and leaves the
 * rest alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	agentMcpLines,
	agentMcpSummaryLines,
	agentRegistrationFacts,
	registerAgentMcp,
} from "../src/lib/instructions/agent-mcp.js";
import type { GatewayProbe } from "../src/lib/instructions/gateway-probe.js";
import {
	buildHookCommand,
	mergeSessionStartHook,
} from "../src/lib/instructions/hook.js";
import { resolveDestinationRoot } from "../src/lib/instructions/safe-write.js";
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

const ORIGIN = "https://deploy.example.com";
const PROJECT = "project-example-one";
const NAME = "fabric-pleone";
const URL = `${ORIGIN}/api/mcp-gateway/projects/${PROJECT}`;
const OTHER_URL = `${ORIGIN}/api/mcp-gateway/projects/project-example-two`;
const ORG_URL = `${ORIGIN}/api/mcp-gateway`;
const FOREIGN_URL = "https://mcp.vendor.example.net/mcp";
const ODD_URL = `${ORIGIN}/mcp`;

afterEach(removeToolFiles);

async function register(
	tools: Tools,
	options: {
		claude?: ClaudeEntry[];
		codex?: string;
		tools?: Array<"claude-code" | "codex">;
		probe?: GatewayProbe;
		checkSignIn?: boolean;
	} = {},
) {
	const files = await toolFiles();
	if (options.claude !== undefined) {
		await writeClaudeFiles(files, options.claude);
	}
	if (options.codex !== undefined) {
		await writeCodexConfig(files, options.codex);
	}
	const { run, calls, statusCalls } = simulateAgentTools(tools, files);
	const results = await registerAgentMcp({
		tools: options.tools ?? ["claude-code"],
		projectId: PROJECT,
		origin: ORIGIN,
		cwd: files.cwd,
		home: files.home,
		env: files.env,
		platform: process.platform,
		run,
		interactive: false,
		...(options.probe === undefined ? {} : { probe: options.probe }),
		...(options.checkSignIn === undefined
			? {}
			: { checkSignIn: options.checkSignIn }),
	});
	return {
		results,
		calls,
		statusCalls,
		lines: agentMcpLines(results),
		summary: agentMcpSummaryLines(results),
		files,
	};
}

function probing(answers: Record<string, Awaited<ReturnType<GatewayProbe>>>) {
	const asked: string[] = [];
	const probe: GatewayProbe = async (url) => {
		asked.push(url);
		return answers[url] ?? "unknown";
	};
	return { probe, asked };
}

describe("a server under any name that points at this project", () => {
	it.each([
		["local", "my-docs"],
		["user", "work-fabric"],
		["project", "team-fabric"],
	] as const)(
		"is the project's server when it is in the %s scope",
		async (scope, name) => {
			const { results, calls, lines } = await register(
				{},
				{ claude: [{ scope, url: URL, name }] },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: "already" });
			expect(results[0]?.name).toBe(name);
			expect(lines[0]).toBe(
				`The Fabric MCP server is already registered for Claude Code as "${name}".`,
			);
		},
	);

	it("is not the one in use when a wider-scope entry of the same name is shadowed by a local one elsewhere", async () => {
		const { results, calls } = await register(
			{},
			{
				claude: [
					{ scope: "user", url: URL, name: "work-fabric" },
					{ scope: "local", url: FOREIGN_URL, name: "work-fabric" },
				],
			},
		);

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.outcome).toEqual({ kind: "registered" });
	});

	it("is found in Codex under a name the person chose", async () => {
		const { results, calls } = await register(
			{},
			{ tools: ["codex"], codex: codexTable("my-fabric", URL) },
		);

		expect(calls).toEqual([]);
		expect(results[0]?.outcome).toEqual({ kind: "already" });
		expect(results[0]?.name).toBe("my-fabric");
	});

	it("prefers the name init registers under when several point here", async () => {
		const { results } = await register(
			{},
			{
				claude: [
					{ scope: "local", url: URL, name: "my-docs" },
					{ scope: "local", url: URL, name: NAME },
					{ scope: "local", url: URL, name: "fabric" },
				],
			},
		);

		expect(results[0]?.name).toBe(NAME);
	});
});

describe("the organization-wide server under any name", () => {
	it.each([
		["local", "work-fabric"],
		["user", "everything"],
		["project", "team-fabric"],
	] as const)(
		"is left alone in the %s scope and gets a note",
		async (scope, name) => {
			const { results, calls, lines } = await register(
				{},
				{ claude: [{ scope, url: ORG_URL, name }] },
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.orgWide).toBe(name);
			expect(lines).toContain(
				`Your organization-wide Fabric server "${name}" stays as it is; coding instructions use the project server "${NAME}".`,
			);
		},
	);

	it("gets the note when the project's server is already there", async () => {
		const { lines, calls } = await register(
			{},
			{
				claude: [
					{ scope: "local", url: URL, name: NAME },
					{ scope: "user", url: ORG_URL, name: "everything" },
				],
			},
		);

		expect(calls).toEqual([]);
		expect(lines).toContain(
			`Your organization-wide Fabric server "everything" stays as it is; coding instructions use the project server "${NAME}".`,
		);
	});

	it("is noted in Codex too", async () => {
		const { results } = await register(
			{},
			{
				tools: ["codex"],
				codex: codexTable("everything", ORG_URL),
			},
		);

		expect(results[0]?.orgWide).toBe("everything");
	});
});

describe("what is replaced as stale, and what never is", () => {
	it("replaces only this checkout's own names at another project", async () => {
		const { results, calls } = await register(
			{},
			{
				claude: [
					{ scope: "local", url: OTHER_URL, name: NAME },
					{ scope: "local", url: OTHER_URL, name: "fabric" },
				],
			},
		);

		expect(verbs(calls)).toEqual([
			"claude mcp remove",
			"claude mcp remove",
			"claude mcp add",
		]);
		expect(calls.slice(0, 2).map((call) => call.args[2])).toEqual([
			NAME,
			"fabric",
		]);
		expect(results[0]?.outcome).toEqual({ kind: "replaced" });
	});

	it.each([
		[
			"a user-scope entry",
			{ scope: "user", url: OTHER_URL, name: "my-fabric" },
		],
		[
			"a local entry under a name init did not choose",
			{ scope: "local", url: OTHER_URL, name: "my-fabric" },
		],
		[
			"a project-scope entry",
			{ scope: "project", url: OTHER_URL, name: "fabric" },
		],
		[
			"a user-scope legacy entry",
			{ scope: "user", url: OTHER_URL, name: "fabric" },
		],
	] as const)(
		"never removes %s that points at another project",
		async (_label, entry) => {
			const { results, calls } = await register({}, { claude: [entry] });

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
		},
	);

	it.each([
		["the organization-wide gateway", ORG_URL],
		["another vendor's server", FOREIGN_URL],
		["a command", null],
	])(
		"never removes a local legacy `fabric` that is %s",
		async (_label, url) => {
			const { calls, results } = await register(
				{},
				{ claude: [{ scope: "local", url, name: "fabric" }] },
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
		},
	);

	it.each([
		["the organization-wide gateway", ORG_URL],
		["another vendor's server", FOREIGN_URL],
		["a command", null],
	])(
		"leaves a server of init's own name that is %s, and says so",
		async (_label, url) => {
			const { calls, results } = await register(
				{},
				{ claude: [{ scope: "local", url, name: NAME }] },
			);

			expect(calls).toEqual([]);
			expect(results[0]?.outcome.kind).toBe("left");
		},
	);

	it("replaces a Codex server of init's name at another project and not a Codex server of another name", async () => {
		const files = await toolFiles();
		await writeCodexConfig(
			files,
			codexTable(NAME, OTHER_URL) + codexTable("my-fabric", OTHER_URL),
		);
		const { run, calls } = simulateAgentTools({}, files);

		const results = await registerAgentMcp({
			tools: ["codex"],
			projectId: PROJECT,
			origin: ORIGIN,
			cwd: files.cwd,
			home: files.home,
			env: files.env,
			platform: process.platform,
			run,
			interactive: true,
		});

		expect(verbs(calls)).toEqual(["codex mcp add"]);
		expect(calls[0]?.args[2]).toBe(NAME);
		expect(results[0]?.outcome).toEqual({ kind: "replaced" });
	});
});

describe("an address on the deployment that no gateway is published at", () => {
	it.each([["this project", "this-project", "already"]] as const)(
		"is the project's server when the probe says %s",
		async (_label, answer, outcome) => {
			const { probe, asked } = probing({ [ODD_URL]: answer });

			const { results, calls } = await register(
				{},
				{
					claude: [
						{ scope: "user", url: ODD_URL, name: "work-fabric" },
					],
					probe,
				},
			);

			expect(asked).toEqual([ODD_URL]);
			expect(calls).toEqual([]);
			expect(results[0]?.outcome).toEqual({ kind: outcome });
			expect(results[0]?.name).toBe("work-fabric");
		},
	);

	it("is the organization-wide server when the probe says so, and is noted", async () => {
		const { probe } = probing({ [ODD_URL]: "org-wide" });

		const { results, calls } = await register(
			{},
			{
				claude: [{ scope: "user", url: ODD_URL, name: "work-fabric" }],
				probe,
			},
		);

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.orgWide).toBe("work-fabric");
	});

	it("is another project's, so replaced only when it holds init's own name", async () => {
		const { probe } = probing({ [ODD_URL]: "other-project" });

		const own = await register(
			{},
			{ claude: [{ scope: "local", url: ODD_URL, name: NAME }], probe },
		);
		const chosen = await register(
			{},
			{
				claude: [{ scope: "local", url: ODD_URL, name: "work-fabric" }],
				probe,
			},
		);

		expect(verbs(own.calls)).toEqual([
			"claude mcp remove",
			"claude mcp add",
		]);
		expect(verbs(chosen.calls)).toEqual(["claude mcp add"]);
	});

	it.each([
		["did not answer", "unknown"],
		["is not Fabric's", "foreign"],
	] as const)(
		"is not counted as the project's when the probe says it %s",
		async (_label, answer) => {
			const { probe } = probing({ [ODD_URL]: answer });

			const { results, calls } = await register(
				{},
				{
					claude: [
						{ scope: "user", url: ODD_URL, name: "work-fabric" },
					],
					probe,
				},
			);

			expect(verbs(calls)).toEqual(["claude mcp add"]);
			expect(results[0]?.outcome).toEqual({ kind: "registered" });
		},
	);

	it("is noted as not told apart when the probe could not tell, and the note carries only its name and host", async () => {
		const { probe } = probing({});

		const { results, lines } = await register(
			{},
			{
				claude: [{ scope: "user", url: ODD_URL, name: "work-fabric" }],
				probe,
			},
		);

		expect(results[0]?.unverified).toEqual([
			{ name: "work-fabric", points: "deploy.example.com" },
		]);
		expect(lines).toContain(
			'Claude Code has a server "work-fabric" at deploy.example.com that could not be told apart from Fabric\'s, so it was left as it is.',
		);
		expect(lines.join("\n")).not.toContain(SECRET);
		expect(lines.join("\n")).not.toContain("/mcp");
	});

	it("counts for nothing when no probe is given", async () => {
		const { results, calls } = await register(
			{},
			{ claude: [{ scope: "user", url: ODD_URL, name: "work-fabric" }] },
		);

		expect(verbs(calls)).toEqual(["claude mcp add"]);
		expect(results[0]?.unverified).toHaveLength(1);
	});

	it("is asked about once, however many entries hold it, and never for another host or a command", async () => {
		const { probe, asked } = probing({ [ODD_URL]: "foreign" });

		await register(
			{},
			{
				claude: [
					{ scope: "user", url: ODD_URL, name: "a" },
					{ scope: "local", url: ODD_URL, name: "b" },
					{ scope: "project", url: FOREIGN_URL, name: "c" },
					{ scope: "project", url: null, name: "d" },
					{ scope: "project", url: URL, name: "e" },
				],
				probe,
			},
		);

		expect(asked).toEqual([ODD_URL]);
	});

	it("is asked about at most a few addresses", async () => {
		const { probe, asked } = probing({});

		await register(
			{},
			{
				claude: Array.from({ length: 9 }, (_, index) => ({
					scope: "user" as const,
					url: `${ORIGIN}/odd/${index}`,
					name: `s${index}`,
				})),
				probe,
			},
		);

		expect(asked).toHaveLength(4);
	});
});

describe("what Claude Code says of the project's server", () => {
	it.each([
		["connected", "connected", `Claude Code: "${NAME}" connected.`],
		[
			"needs-auth",
			"needs-sign-in",
			`Claude Code: "${NAME}" registered, needs sign-in.`,
		],
		[
			"disconnected",
			"unreachable",
			`Claude Code: "${NAME}" registered, unreachable (deploy.example.com).`,
		],
		[
			"not-connected",
			"unreachable",
			`Claude Code: "${NAME}" registered, unreachable (deploy.example.com).`,
		],
		[
			"reconnected",
			"unavailable",
			`Claude Code: "${NAME}" registered; its status could not be read.`,
		],
	] as const)("is read from %s as %s", async (claudeStatus, status, line) => {
		const { results, summary, statusCalls } = await register(
			{ claudeStatus },
			{ claude: [{ scope: "local", url: URL, name: NAME }] },
		);

		expect(results[0]?.status).toBe(status);
		expect(summary).toEqual([line]);
		expect(statusCalls.map((call) => call.args)).toEqual([
			["mcp", "get", NAME],
		]);
	});

	it("asks about the project's server only, never lists, and not at all when told not to", async () => {
		const asked = await register(
			{},
			{
				claude: [
					{ scope: "user", url: ORG_URL, name: "everything" },
					{ scope: "local", url: URL, name: NAME },
				],
			},
		);
		const silent = await register(
			{},
			{
				claude: [{ scope: "local", url: URL, name: NAME }],
				checkSignIn: false,
			},
		);

		expect(asked.statusCalls.map((call) => call.args)).toEqual([
			["mcp", "get", NAME],
		]);
		expect(silent.statusCalls).toEqual([]);
		expect(silent.summary).toEqual([`Claude Code: "${NAME}" registered.`]);
	});

	it("is asked under the name the server is found under", async () => {
		const { statusCalls, summary } = await register(
			{ claudeStatus: "connected" },
			{ claude: [{ scope: "user", url: URL, name: "work-fabric" }] },
		);

		expect(statusCalls.map((call) => call.args)).toEqual([
			["mcp", "get", "work-fabric"],
		]);
		expect(summary).toEqual(['Claude Code: "work-fabric" connected.']);
	});

	it("says there is nothing usable when nothing could be registered", async () => {
		const { summary } = await register({ claudeAdd: "fails" }, {});

		expect(summary).toEqual([
			"Claude Code: nothing usable for this project, see above.",
		]);
	});
});

describe("what Codex says of the project's server", () => {
	it("is that its sign-in status is not available, and it is not asked", async () => {
		const { results, summary, statusCalls, calls } = await register(
			{},
			{
				tools: ["codex"],
				codex: codexTable("fabric-pleone", URL),
			},
		);

		expect(results[0]?.status).toBe("unavailable");
		expect(statusCalls).toEqual([]);
		expect(calls).toEqual([]);
		expect(summary).toEqual([
			`Codex: "${NAME}" registered; sign-in status not available for Codex.`,
		]);
		expect(results[0]?.loginLine).toBe(`codex mcp login ${NAME}`);
	});
});

describe("the facts doctor reads", () => {
	async function facts(options: {
		claude?: ClaudeEntry[];
		codex?: string;
		probe?: GatewayProbe;
	}) {
		const files = await toolFiles();
		const root = await resolveDestinationRoot(files.cwd);
		for (const tool of ["claude-code", "codex"] as const) {
			await mergeSessionStartHook({
				root,
				projectId: PROJECT,
				command: buildHookCommand(PROJECT, false, undefined, {
					baseUrl: ORIGIN,
				}),
				tool,
			});
		}
		if (options.claude !== undefined) {
			await writeClaudeFiles(files, options.claude);
		}
		await writeCodexConfig(files, options.codex ?? "");
		return agentRegistrationFacts({
			root,
			cwd: files.cwd,
			projectId: PROJECT,
			origin: ORIGIN,
			home: files.home,
			env: files.env,
			platform: process.platform,
			...(options.probe === undefined ? {} : { probe: options.probe }),
		});
	}

	it("lists every name the project is registered under, so duplicates show", async () => {
		const found = await facts({
			claude: [
				{ scope: "local", url: URL, name: NAME },
				{ scope: "local", url: `${URL}/`, name: "fabric" },
				{ scope: "user", url: URL, name: "work-fabric" },
			],
		});

		expect(found[0]).toMatchObject({
			tool: "claude-code",
			state: "registered",
			projectServers: [NAME, "fabric", "work-fabric"],
		});
	});

	it("names the organization-wide server under any name and a foreign server under init's", async () => {
		const found = await facts({
			claude: [
				{ scope: "user", url: ORG_URL, name: "everything" },
				{ scope: "local", url: URL, name: "work-fabric" },
				{ scope: "user", url: FOREIGN_URL, name: NAME },
			],
		});

		expect(found[0]).toMatchObject({
			state: "registered",
			orgWide: ["everything"],
			foreignSameName: true,
		});
	});

	it("reads Codex the same way", async () => {
		const found = await facts({
			codex:
				codexTable("my-fabric", URL) +
				codexTable("everything", ORG_URL),
		});

		expect(found[1]).toMatchObject({
			tool: "codex",
			state: "registered",
			projectServers: ["my-fabric"],
			orgWide: ["everything"],
		});
	});

	it("uses the probe for an unfamiliar spelling", async () => {
		const { probe } = probing({ [ODD_URL]: "this-project" });

		const found = await facts({
			claude: [{ scope: "user", url: ODD_URL, name: "work-fabric" }],
			probe,
		});

		expect(found[0]).toMatchObject({
			state: "registered",
			projectServers: ["work-fabric"],
		});
	});

	it("reports the legacy name alone as legacy", async () => {
		const found = await facts({
			claude: [{ scope: "local", url: URL, name: "fabric" }],
		});

		expect(found[0]).toMatchObject({
			state: "legacy",
			projectServers: ["fabric"],
		});
	});
});
