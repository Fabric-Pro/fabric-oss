/**
 * An agent task runs unattended, as the workflow's owner, so everything it may
 * do is settled before the workflow can go live. These pin each rule that
 * holds a graph back, and — as important — that other workflows are left alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { ownMcpConfigIds, projectPlacementRefusal } = vi.hoisted(() => ({
	ownMcpConfigIds: vi.fn(),
	projectPlacementRefusal: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	ownMcpConfigIds,
	projectPlacementRefusal,
	BUILT_IN_TO_FABRIC_TOOLS: {
		"project-context": ["project_rag_query"],
		"create-frames": ["fabric_create_frame"],
		"run-agent": [],
		"web-search": ["fabric_web_search"],
		"web-search-browse": ["fabric_web_search"],
		"code-interpreter": ["fabric_code_interpreter"],
	},
}));

import { findAgenticPublishProblems } from "../agentic-publish-validation";

function server(
	id: string,
	overrides: Partial<{
		enabled: boolean;
		displayName: string | null;
		mcpServer: { name: string } | null;
	}> = {},
) {
	return {
		id,
		enabled: true,
		displayName: null,
		mcpServer: null,
		...overrides,
	};
}

function trigger(config: Record<string, unknown> = {}) {
	return {
		id: "trigger",
		type: "trigger",
		data: {
			label: "Schedule",
			config: {
				triggerType: "schedule",
				scheduleCron: "0 9 * * 1",
				...config,
			},
		},
	};
}

function agentTask(config: Record<string, unknown> = {}) {
	return {
		id: "agent",
		type: "agent-task",
		data: {
			label: "Agent Task",
			config: { prompt: "Summarise the work.", ...config },
		},
	};
}

function publishFrame(config: Record<string, unknown> = {}) {
	return {
		id: "publish",
		type: "publish-frame",
		data: {
			label: "Publish Frame",
			config: {
				title: "Status",
				content: "{{Agent Task.html}}",
				...config,
			},
		},
	};
}

const OWNER = { userId: "user-1", organizationId: "org-1" };

function checkFull(
	nodes: unknown,
	overrides: Partial<Parameters<typeof findAgenticPublishProblems>[0]> = {},
) {
	return findAgenticPublishProblems({
		nodes,
		...OWNER,
		projectId: null,
		...overrides,
	});
}

async function check(
	nodes: unknown,
	overrides: Partial<Parameters<typeof findAgenticPublishProblems>[0]> = {},
) {
	return (await checkFull(nodes, overrides)).problems;
}

beforeEach(() => {
	vi.clearAllMocks();
	ownMcpConfigIds.mockResolvedValue([]);
	projectPlacementRefusal.mockResolvedValue(null);
});

describe("graphs without agentic nodes", () => {
	it("are left alone, whatever their schedule", async () => {
		const nodes = [
			trigger({ scheduleCron: "* * * * *" }),
			{ id: "n2", type: "http-request", data: { config: {} } },
		];

		expect(await check(nodes)).toEqual([]);
		expect(ownMcpConfigIds).not.toHaveBeenCalled();
	});

	it("tolerate a graph that is not a node list", async () => {
		expect(await check(null)).toEqual([]);
		expect(await check("nope")).toEqual([]);
	});
});

describe("node config", () => {
	it("holds each node to its schema", async () => {
		const problems = await check([
			trigger(),
			agentTask({ prompt: "   " }),
			publishFrame({ title: "" }),
		]);

		expect(problems.join("\n")).toContain("Agent Task: prompt");
		expect(problems.join("\n")).toContain("Publish Frame: title");
	});

	it("accepts a well-formed preset graph", async () => {
		expect(
			await check([trigger(), agentTask(), publishFrame()], {
				projectId: "proj-1",
			}),
		).toEqual([]);
	});
});

describe("schedule interval", () => {
	it.each([
		["every 5 minutes", "*/5 * * * *"],
		["every minute", "* * * * *"],
		["twice an hour, ten minutes apart", "0,10 9 * * *"],
		["every 14 minutes", "*/14 * * * *"],
	])("refuses an agent task that runs %s", async (_label, cron) => {
		const problems = await check([
			trigger({ scheduleCron: cron }),
			agentTask(),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(cron);
		expect(problems[0]).toContain("at most every 15 minutes");
	});

	it.each([
		["every 15 minutes", "*/15 * * * *"],
		["hourly", "0 * * * *"],
		["daily", "0 9 * * *"],
		["weekly", "0 9 * * 1"],
		["monthly", "0 9 1 * *"],
		["weekdays only", "0 9 * * 1-5"],
		["with a Temporal year field", "0 9 * * 1 2030"],
	])("allows an agent task that runs %s", async (_label, cron) => {
		expect(
			await check([trigger({ scheduleCron: cron }), agentTask()]),
		).toEqual([]);
	});

	it("refuses a schedule whose interval cannot be measured", async () => {
		const problems = await check([
			trigger({ scheduleCron: "99 * * * *" }),
			agentTask(),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("interval can be checked");
	});

	it("does not require a schedule: a manually started agent task has no interval", async () => {
		expect(
			await check([trigger({ triggerType: "manual" }), agentTask()]),
		).toEqual([]);
	});
});

describe("schedule time zone", () => {
	it("accepts an IANA zone", async () => {
		expect(
			await check([
				trigger({ scheduleTimezone: "Europe/Berlin" }),
				agentTask(),
			]),
		).toEqual([]);
	});

	it("refuses an unknown zone", async () => {
		const problems = await check([
			trigger({ scheduleTimezone: "Mars/Phobos" }),
			agentTask(),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("Mars/Phobos");
	});

	it("refuses an unknown zone on a workflow with no agent, which would never get its schedule", async () => {
		const problems = await check([
			trigger({ scheduleTimezone: "nonsense" }),
		]);

		expect(problems).toHaveLength(1);
	});

	it("treats a workflow saved without a zone as UTC", async () => {
		expect(await check([trigger(), agentTask()])).toEqual([]);
	});
});

describe("MCP servers", () => {
	it("looks servers up as the owner in the organization, through the shared query", async () => {
		ownMcpConfigIds.mockResolvedValue([
			server("mcp-1", { displayName: "Tracker" }),
		]);

		const problems = await check([
			trigger(),
			agentTask({ mcpConfigIds: ["mcp-1"] }),
		]);

		expect(problems).toEqual([]);
		expect(ownMcpConfigIds).toHaveBeenCalledExactlyOnceWith(["mcp-1"], {
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("returns the servers it found, named the way the person knows them", async () => {
		ownMcpConfigIds.mockResolvedValue([
			server("mcp-1", { displayName: "Tracker" }),
			server("mcp-2", { mcpServer: { name: "Example Docs" } }),
			server("mcp-3"),
		]);

		const { mcpServers } = await checkFull([
			trigger(),
			agentTask({ mcpConfigIds: ["mcp-1", "mcp-2", "mcp-3", "gone"] }),
		]);

		expect(mcpServers).toEqual([
			{ configId: "mcp-1", name: "Tracker" },
			{ configId: "mcp-2", name: "Example Docs" },
			{ configId: "mcp-3", name: "mcp-3" },
		]);
	});

	it("returns no servers when none is named", async () => {
		const { mcpServers } = await checkFull([trigger(), agentTask()]);

		expect(mcpServers).toEqual([]);
	});

	it("refuses a server owned by another user or another organization", async () => {
		ownMcpConfigIds.mockResolvedValue([]);

		const problems = await check([
			trigger(),
			agentTask({ mcpConfigIds: ["someone-elses"] }),
		]);

		expect(problems).toEqual([
			"Agent Task: MCP server someone-elses is not one of your servers in this organization.",
		]);
	});

	it("refuses every id the shared query did not return as the owner's own", async () => {
		ownMcpConfigIds.mockResolvedValue([server("mine")]);

		const problems = await check([
			trigger(),
			agentTask({
				mcpConfigIds: ["mine", "colleagues", "other-org", "org-less"],
			}),
		]);

		expect(problems).toHaveLength(3);
		expect(problems.join("\n")).not.toContain("MCP server mine ");
		for (const rejected of ["colleagues", "other-org", "org-less"]) {
			expect(problems.join("\n")).toContain(
				`MCP server ${rejected} is not`,
			);
		}
	});

	it("refuses a disabled server, which would leave the agent without its tools", async () => {
		ownMcpConfigIds.mockResolvedValue([
			server("mcp-1", { enabled: false, displayName: "Tracker" }),
		]);

		const problems = await check([
			trigger(),
			agentTask({ mcpConfigIds: ["mcp-1"] }),
		]);

		expect(problems).toEqual([
			'Agent Task: MCP server "Tracker" is disabled.',
		]);
	});

	it("fails closed when the servers cannot be looked up", async () => {
		ownMcpConfigIds.mockRejectedValue(new Error("db down"));

		const problems = await check([
			trigger(),
			agentTask({ mcpConfigIds: ["mcp-1"] }),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("could not be verified");
	});

	it("asks nothing when the agent names no server", async () => {
		await check([trigger(), agentTask()]);

		expect(ownMcpConfigIds).not.toHaveBeenCalled();
	});

	it("refuses an agent task in a workflow with no organization", async () => {
		const problems = await check([trigger(), agentTask()], {
			organizationId: null,
		});

		expect(problems).toEqual([
			"Agent tasks run inside an organization; this workflow has none.",
		]);
		expect(ownMcpConfigIds).not.toHaveBeenCalled();
	});

	it("checks every agent task in the graph with one lookup", async () => {
		const second = { ...agentTask({ mcpConfigIds: ["b"] }), id: "agent-2" };
		second.data.label = "Second Agent";

		const problems = await check([
			trigger(),
			agentTask({ mcpConfigIds: ["a"] }),
			second,
		]);

		expect(problems).toHaveLength(2);
		expect(ownMcpConfigIds).toHaveBeenCalledOnce();
		expect(ownMcpConfigIds.mock.calls[0][0]).toEqual(["a", "b"]);
	});
});

describe("capabilities an unattended agent may not hold", () => {
	it.each([
		["create-frames", "Publish Frame"],
		["run-agent", "other agents"],
		["web-search", "addresses of its own choosing"],
		["web-search-browse", "addresses of its own choosing"],
		["code-interpreter", "run code"],
	])("refuses %s", async (capability, hint) => {
		const problems = await check([
			trigger(),
			agentTask({ builtInToolNames: [capability] }),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`"${capability}" is not allowed`);
		expect(problems[0]).toContain(hint);
	});
});

describe("built-in capabilities", () => {
	it("accepts a capability that cannot carry data out", async () => {
		expect(
			await check([
				trigger(),
				agentTask({ builtInToolNames: ["project-context"] }),
			]),
		).toEqual([]);
	});

	it("refuses a name the platform does not have", async () => {
		const problems = await check([
			trigger(),
			agentTask({
				builtInToolNames: ["project-context", "shell-access"],
			}),
		]);

		expect(problems).toEqual([
			'Agent Task: "shell-access" is not a built-in capability an agent can use.',
		]);
	});
});

describe("where a frame is published", () => {
	const graph = (frameConfig: Record<string, unknown> = {}) => [
		trigger(),
		agentTask(),
		publishFrame(frameConfig),
	];

	it("refuses an artifact when neither the step nor the workflow has a project", async () => {
		const problems = await check(graph(), { projectId: null });

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("needs a project");
	});

	it("takes the project from the workflow and asks the shared placement check", async () => {
		expect(await check(graph(), { projectId: "proj-1" })).toEqual([]);
		expect(projectPlacementRefusal).toHaveBeenCalledExactlyOnceWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
		});
	});

	it("lets the step's own project win over the workflow's", async () => {
		await check(graph({ projectId: "step-project" }), {
			projectId: "workflow-project",
		});

		expect(projectPlacementRefusal).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "step-project" }),
		);
		expect(projectPlacementRefusal).not.toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "workflow-project" }),
		);
	});

	it("refuses a project the placement check reports missing (hidden, in another organization, or in the trash)", async () => {
		projectPlacementRefusal.mockResolvedValue("not_found");

		const problems = await check(graph({ projectId: "hidden" }));

		expect(problems).toEqual([
			"Publish Frame: the project does not exist or you have no access to it.",
		]);
	});

	it("refuses a project the owner may read but not add to", async () => {
		projectPlacementRefusal.mockResolvedValue("not_editable");

		const problems = await check(graph({ projectId: "read-only" }));

		expect(problems).toEqual([
			"Publish Frame: you may not add frames to that project.",
		]);
	});

	it("fails closed when the project cannot be checked", async () => {
		projectPlacementRefusal.mockRejectedValue(new Error("db down"));

		const problems = await check(graph({ projectId: "proj-1" }));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("could not be verified");
	});

	it("checks the workflow's project once however many steps share it", async () => {
		await check([...graph(), { ...publishFrame(), id: "publish-2" }], {
			projectId: "proj-1",
		});

		expect(projectPlacementRefusal).toHaveBeenCalledOnce();
	});

	it("does not demand a project for a workspace frame", async () => {
		expect(
			await check(graph({ surface: "workspace" }), { projectId: null }),
		).toEqual([]);
	});

	it("still checks a project the step names when the workflow has none", async () => {
		projectPlacementRefusal.mockResolvedValue("not_found");

		expect(await check(graph({ projectId: "hidden" }))).toHaveLength(1);
	});
});
