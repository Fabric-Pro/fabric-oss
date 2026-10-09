/**
 * What `doctor` says about a project's own sign-in and about each coding tool's
 * registration of the project's Fabric MCP server. Both are folded into checks
 * that already exist (`auth`, `mcp-servers`), because the vocabulary of check
 * ids is shared with the gateway and closed. `runDoctor` is called directly
 * with the facts a caller read from the machine; reading them is
 * `agent-mcp-config.test.ts`.
 */
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WhoamiResult } from "@fabricorg/sdk";
import { describe, expect, it } from "vitest";
import type { AgentMcpFact } from "../src/lib/instructions/agent-mcp-config.js";
import type { InstructionCheck } from "../src/lib/instructions/checks.js";
import { type DoctorInput, runDoctor } from "../src/lib/instructions/doctor.js";
import { NO_LINE_FOR_ADDRESS } from "../src/lib/shell-words.js";

const PROJECT = "project-example-one";

async function tree(mcpServers?: Record<string, unknown>): Promise<string> {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-doctor-agent-")),
	);
	if (mcpServers !== undefined) {
		await writeFile(
			path.join(root, ".mcp.json"),
			JSON.stringify({ mcpServers }),
			"utf8",
		);
	}
	return root;
}

function who(overrides: Partial<WhoamiResult>): WhoamiResult {
	return {
		user: {
			id: "user-1",
			name: "Dev",
			email: "dev@example.com",
			role: "user",
			createdAt: "2026-01-02T03:04:05.000Z",
		},
		keyType: "oauth",
		keyPrefix: "fat_",
		scopes: ["instructions:read"],
		orgs: [],
		...overrides,
	} as WhoamiResult;
}

function inputFor(
	root: string,
	extra: Partial<DoctorInput> & { whoami?: WhoamiResult } = {},
): DoctorInput {
	const { whoami, ...rest } = extra;
	const unreachable = () => {
		throw new Error("not used by this test");
	};
	return {
		projectId: PROJECT,
		destination: root,
		root,
		probeNetwork: false,
		env: {},
		platform: "linux",
		apiKeyPresent: whoami !== undefined,
		client: () => ({
			auth: {
				whoami: async () => whoami ?? unreachable(),
			},
			instructions: {
				getPublished: async () => unreachable(),
			},
		}),
		createDownloadUrl: async () => unreachable(),
		fetchArchive: async () => unreachable(),
		...rest,
	};
}

async function checkOf(
	input: DoctorInput,
	id: "auth" | "mcp-servers",
): Promise<InstructionCheck> {
	const report = await runDoctor(input);
	const check = report.checks.find((candidate) => candidate.id === id);
	if (!check) {
		throw new Error(`no ${id} check in the report`);
	}
	return check;
}

function fact(
	tool: AgentMcpFact["tool"],
	state: AgentMcpFact["state"],
): AgentMcpFact {
	const name = "fabric-pleone";
	return {
		tool,
		name,
		state,
		projectServers:
			state === "registered"
				? [name]
				: state === "legacy"
					? ["fabric"]
					: [],
		orgWide: [],
		foreignSameName: false,
		registerLine:
			tool === "codex"
				? `codex mcp add ${name} --url https://deploy.example.com/api/mcp-gateway/projects/${PROJECT}`
				: `claude mcp add --scope local --transport http ${name} https://deploy.example.com/api/mcp-gateway/projects/${PROJECT}`,
	};
}

describe("doctor's auth check and a project's own sign-in", () => {
	it("says a sign-in that is limited to this project is", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				whoami: who({ projectContext: PROJECT }),
				projectSignIn: true,
			}),
			"auth",
		);

		expect(check.status).toBe("pass");
		expect(check.detail).toBe(
			"signed-in session limited to this project with instructions:read",
		);
	});

	it("does not take a sign-in limited to another project for this one's", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				whoami: who({ projectContext: "project-example-two" }),
				projectSignIn: true,
			}),
			"auth",
		);

		expect(check.detail).toBe("signed-in session with instructions:read");
	});

	it("tells a person whose sign-in reaches every project that this project has none of its own", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, { whoami: who({}), projectSignIn: false }),
			"auth",
		);

		expect(check.status).toBe("pass");
		expect(check.detail).toBe(
			"signed-in session with instructions:read; this project has no sign-in of its own",
		);
	});

	it.each([
		["has one", { projectSignIn: true }],
		["was not looked up", {}],
	])(
		"adds nothing to a deployment-wide sign-in when the project %s",
		async (_label, extra) => {
			const root = await tree();

			const check = await checkOf(
				inputFor(root, { whoami: who({}), ...extra }),
				"auth",
			);

			expect(check.detail).toBe(
				"signed-in session with instructions:read",
			);
		},
	);

	it("says nothing of a project sign-in about an organization key", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				whoami: who({ keyType: "organization", keyPrefix: "org_abc" }),
				projectSignIn: false,
			}),
			"auth",
		);

		expect(check.detail).toBe(
			"organization key org_abc with instructions:read",
		);
	});
});

describe("doctor's mcp-servers check and the tools' registrations", () => {
	it("passes when every tool the project's hook is set up for has the server, with no .mcp.json at all", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [
					fact("claude-code", "registered"),
					fact("codex", "registered"),
				],
			}),
			"mcp-servers",
		);

		expect(check.status).toBe("pass");
		expect(check.items).toEqual([
			{
				name: "Fabric server in Claude Code",
				status: "pass",
				detail: "registered at this project's gateway",
			},
			{
				name: "Fabric server in Codex",
				status: "pass",
				detail: "registered at this project's gateway",
			},
		]);
		expect(check.fix).toBeUndefined();
	});

	it("only skips a tool with no registration, and proposes nothing, because leaving it out is a choice", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, { agentMcp: [fact("claude-code", "missing")] }),
			"mcp-servers",
		);

		expect(check.status).toBe("skip");
		expect(check.items).toEqual([
			{
				name: "Fabric server in Claude Code",
				status: "skip",
				detail: "not registered; init registers it, unless it was run with --no-mcp or, for Codex, with no terminal to sign in at",
			},
		]);
		expect(check.fix).toBeUndefined();
	});

	it("warns when the server's name points somewhere else, and gives the line that registers this project's", async () => {
		const root = await tree();
		const elsewhere = fact("codex", "elsewhere");

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [fact("claude-code", "registered"), elsewhere],
			}),
			"mcp-servers",
		);

		expect(check.status).toBe("warn");
		expect(check.items?.[1]).toEqual({
			name: "Fabric server in Codex",
			status: "warn",
			detail: '"fabric-pleone" is registered, but not at this project\'s gateway',
		});
		expect(check.fix).toEqual({
			command: elsewhere.registerLine,
			description:
				'remove the "fabric-pleone" server from Codex so it can be registered for this project, then run init or this line',
		});
	});

	it("warns, not errors, about a server registered under the older name, with the line to remove it", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, { agentMcp: [fact("claude-code", "legacy")] }),
			"mcp-servers",
		);

		expect(check.status).toBe("warn");
		expect(check.items?.[0]?.status).toBe("warn");
		expect(check.items?.[0]?.detail).toContain('older name "fabric"');
		expect(check.fix?.command).toBe(
			"claude mcp remove fabric --scope local",
		);
	});

	it("warns when the project's gateway is registered under several names", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [
					{
						...fact("claude-code", "registered"),
						projectServers: ["fabric-pleone", "work-fabric"],
					},
				],
			}),
			"mcp-servers",
		);

		expect(check.status).toBe("warn");
		expect(check.items?.[0]).toEqual({
			name: "Fabric server in Claude Code",
			status: "warn",
			detail: 'this project\'s gateway is registered under 2 names ("fabric-pleone", "work-fabric"); one is enough',
		});
	});

	it("offers to remove the older name when it duplicates the current one", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [
					{
						...fact("claude-code", "registered"),
						projectServers: ["fabric-pleone", "fabric"],
					},
				],
			}),
			"mcp-servers",
		);

		expect(check.items?.[0]?.status).toBe("warn");
		expect(check.fix?.command).toBe(
			"claude mcp remove fabric --scope local",
		);
	});

	it("notes the organization-wide server without warning about it", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [
					{ ...fact("codex", "registered"), orgWide: ["everything"] },
				],
			}),
			"mcp-servers",
		);

		expect(check.status).toBe("pass");
		expect(check.items?.[1]).toEqual({
			name: "Organization-wide Fabric server in Codex",
			status: "skip",
			detail: 'present as "everything"; left as it is, coding instructions use the project server',
		});
	});

	it("notes a server under init's name that is not Fabric's, when the project is registered under another", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, {
				agentMcp: [
					{
						...fact("claude-code", "registered"),
						projectServers: ["work-fabric"],
						foreignSameName: true,
					},
				],
			}),
			"mcp-servers",
		);

		expect(check.status).toBe("pass");
		expect(check.items?.[1]).toEqual({
			name: 'Server named "fabric-pleone" in Claude Code',
			status: "skip",
			detail: "not Fabric's; left as it is",
		});
	});

	it("skips a tool whose configuration could not be read, without saying why", async () => {
		const root = await tree();

		const check = await checkOf(
			inputFor(root, { agentMcp: [fact("codex", "unreadable")] }),
			"mcp-servers",
		);

		expect(check.items).toEqual([
			{
				name: "Fabric server in Codex",
				status: "skip",
				detail: "its configuration could not be read",
			},
		]);
	});

	it("is the same skip as before when there are no registrations and no .mcp.json", async () => {
		const root = await tree();

		const none = await checkOf(inputFor(root), "mcp-servers");
		const empty = await checkOf(
			inputFor(root, { agentMcp: [] }),
			"mcp-servers",
		);

		for (const check of [none, empty]) {
			expect(check.status).toBe("skip");
			expect(check.items).toBeUndefined();
			expect(check.detail).toContain("no .mcp.json in");
		}
	});

	it("lists the registrations after the servers the .mcp.json names, so their positions do not move", async () => {
		const root = await tree({
			docs: { url: "https://docs.example.net/mcp" },
		});

		const check = await checkOf(
			inputFor(root, { agentMcp: [fact("claude-code", "registered")] }),
			"mcp-servers",
		);

		expect(check.items?.map((item) => item.name)).toEqual([
			"docs",
			"Fabric server in Claude Code",
		]);
		expect(check.items?.[1]?.status).toBe("pass");
	});

	it("proposes the registration line when the .mcp.json has nothing to fix", async () => {
		const root = await tree({
			docs: { url: "https://docs.example.net/mcp" },
		});
		const elsewhere = fact("claude-code", "elsewhere");

		const check = await checkOf(
			inputFor(root, { agentMcp: [elsewhere] }),
			"mcp-servers",
		);

		expect(check.status).toBe("warn");
		expect(check.fix?.command).toBe(elsewhere.registerLine);
	});

	it("keeps the fix for a failing .mcp.json server ahead of a registration's", async () => {
		const root = await tree({
			broken: { command: "fabric-no-such-tool-on-path" },
		});

		const check = await checkOf(
			inputFor(root, { agentMcp: [fact("claude-code", "elsewhere")] }),
			"mcp-servers",
		);

		expect(check.status).toBe("fail");
		expect(check.fix?.description).toContain(
			"fix or remove the failing server",
		);
		expect(check.fix?.command).toBeUndefined();
	});

	it("proposes no line when the address cannot be written into one, and says so without repeating it", async () => {
		const root = await tree();
		const elsewhere: AgentMcpFact = {
			...fact("claude-code", "elsewhere"),
			registerLine: null,
		};

		const check = await checkOf(
			inputFor(root, { agentMcp: [elsewhere] }),
			"mcp-servers",
		);

		expect(check.status).toBe("warn");
		expect(check.fix).toEqual({
			description: `remove the "fabric-pleone" server from Claude Code so it can be registered for this project, then register it by hand. ${NO_LINE_FOR_ADDRESS}`,
		});
		expect(check.fix).not.toHaveProperty("command");
	});
});
