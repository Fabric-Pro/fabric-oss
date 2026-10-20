import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connection: vi.fn(),
	frame: vi.fn(),
	agent: vi.fn(),
	skill: vi.fn(),
	file: vi.fn(),
	agentPermission: vi.fn(),
	skillPermission: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getFrameById: mocks.frame,
	getInstanceWithTemplate: mocks.agent,
	canReadOrganizationAgentTemplates: mocks.agentPermission,
	canReadOrganizationSkills: mocks.skillPermission,
	ownMcpConfigIds: vi.fn(),
	projectPlacementRefusal: vi.fn(),
	BUILT_IN_TO_FABRIC_TOOLS: {},
}));
vi.mock("@repo/mcp/lib/project-pm-read", () => ({
	resolveProjectPmRead: mocks.connection,
}));
vi.mock("@repo/ai/skills", () => ({
	loadSkillBundle: mocks.skill,
	readSkillFile: mocks.file,
}));

import { findAgenticPublishProblems } from "../agentic-publish-validation";

const actor = {
	userId: "owner-1",
	organizationId: "org-1",
	projectId: "project-1",
};

function review(config: Record<string, unknown> = {}) {
	return {
		id: "review-1",
		type: "mcp-review-ado-stories",
		data: {
			label: "Story review",
			config: {
				assignee: { mode: "current" },
				rubric: "Check completeness.",
				...config,
			},
		},
	};
}

function schedule(cron: string) {
	return {
		id: "trigger",
		type: "trigger",
		data: { config: { triggerType: "schedule", scheduleCron: cron } },
	};
}

async function problems(
	nodes: unknown[] = [review()],
	overrides: Partial<typeof actor> = {},
) {
	return (await findAgenticPublishProblems({ nodes, ...actor, ...overrides }))
		.problems;
}

function agent() {
	return {
		id: "agent-1",
		organizationId: actor.organizationId,
		status: "ACTIVE",
		version: 1,
		description: null,
		customInstructions: null,
		modelOverride: null,
		template: {
			displayName: "Reviewer",
			description: "Reviews requirements.",
			instructions: "Check clarity.",
			suggestedModel: null,
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.connection.mockResolvedValue({
		status: "ready",
		target: { organization: "example", projectId: "ado-project-1" },
		pat: "synthetic-pat",
	});
	mocks.agentPermission.mockResolvedValue(true);
	mocks.skillPermission.mockResolvedValue(true);
	mocks.agent.mockResolvedValue(agent());
	mocks.skill.mockResolvedValue({
		slug: "requirements",
		version: 1,
		skillMd: "Review requirements.",
		files: [
			{
				path: "references/checklist.md",
				sizeBytes: 100,
				contentType: "text/markdown",
			},
		],
	});
	mocks.file.mockResolvedValue({
		encoding: "utf-8",
		data: "Check acceptance criteria.",
	});
	mocks.frame.mockResolvedValue({
		id: "workspace-1",
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId: actor.projectId,
		surface: "workspace",
	});
});

describe("story review publish authorization", () => {
	it("checks the attached project and current workflow owner, without enumerating ADO members", async () => {
		expect(
			await problems([
				review({
					assignee: {
						mode: "selected",
						uniqueName: "member@example.com",
					},
				}),
			]),
		).toEqual([]);
		expect(mocks.connection).toHaveBeenCalledTimes(1);
		expect(mocks.connection).toHaveBeenCalledWith(actor);
		expect(mocks.agentPermission).not.toHaveBeenCalled();
		expect(mocks.skillPermission).not.toHaveBeenCalled();
	});

	it.each([
		"not_found",
		"forbidden",
		"not_configured",
		"not_connected",
		"unsupported",
	])("refuses %s project connections", async (status) => {
		mocks.connection.mockResolvedValue({ status });
		expect((await problems()).join(" ")).toContain(
			"owner needs a connected Azure DevOps account",
		);
		expect(mocks.agent).not.toHaveBeenCalled();
	});

	it.each(["organizationId", "projectId"])(
		"requires %s before accessing connections",
		async (field) => {
			const input = { nodes: [review()], ...actor, [field]: null };
			expect(
				(await findAgenticPublishProblems(input)).problems.join(" "),
			).toContain("link this workflow to a project");
			expect(mocks.connection).not.toHaveBeenCalled();
		},
	);

	it("returns a bounded refusal when connection lookup fails, without error or credential text", async () => {
		mocks.connection.mockRejectedValue(
			new Error("synthetic-sensitive-error"),
		);
		const result = (await problems()).join(" ");
		expect(result).toContain("could not be verified");
		expect(result).not.toContain("synthetic-sensitive-error");
	});

	it.each([
		{ rubric: " " },
		{ assignee: { mode: "selected", uniqueName: "" } },
		{ maxStories: 51 },
		{ workItemTypes: [] },
		{ requirementFields: ["unscoped"] },
		{ skills: [{ slug: "requirements", textFiles: ["scripts/run.js"] }] },
	])(
		"rejects invalid config before resolving credentials: %s",
		async (config) => {
			expect((await problems([review(config)])).length).toBeGreaterThan(
				0,
			);
			expect(mocks.connection).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		{ userId: "other-owner" },
		{ organizationId: "other-org" },
		{ projectId: "other-project" },
		{ surface: "artifact" },
	])("refuses an unavailable or foreign Workspace: %s", async (override) => {
		mocks.frame.mockResolvedValue(
			override && {
				id: "workspace-1",
				userId: actor.userId,
				organizationId: actor.organizationId,
				projectId: actor.projectId,
				surface: "workspace",
				...override,
			},
		);
		expect(
			(
				await problems([review({ workspaceFrameId: "workspace-1" })])
			).join(" "),
		).toContain("choose one of your Workspaces");
		expect(mocks.frame).toHaveBeenCalledWith({
			id: "workspace-1",
			userId: actor.userId,
			organizationId: actor.organizationId,
		});
	});

	it("allows an owned, unattached Workspace", async () => {
		mocks.frame.mockResolvedValue({
			id: "workspace-1",
			userId: actor.userId,
			organizationId: actor.organizationId,
			projectId: null,
			surface: "workspace",
		});
		expect(
			await problems([review({ workspaceFrameId: "workspace-1" })]),
		).toEqual([]);
	});
});

describe("review instruction selections", () => {
	it("uses the canonical instruction loader for active, tenant-scoped agent and published skill text", async () => {
		expect(
			await problems([
				review({
					agentInstructionsInstanceId: "agent-1",
					skills: [
						{
							slug: "requirements",
							textFiles: ["references/checklist.md"],
						},
					],
				}),
			]),
		).toEqual([]);
		expect(mocks.agentPermission).toHaveBeenCalledWith(
			actor.userId,
			actor.organizationId,
		);
		expect(mocks.agent).toHaveBeenCalledWith(
			"agent-1",
			actor.userId,
			actor.organizationId,
		);
		expect(mocks.skillPermission).toHaveBeenCalledWith(
			actor.userId,
			actor.organizationId,
		);
		expect(mocks.skill).toHaveBeenCalledWith(
			"requirements",
			expect.objectContaining(actor),
			{ fresh: true },
		);
		expect(mocks.file).toHaveBeenCalledWith(
			"requirements",
			"references/checklist.md",
			expect.objectContaining(actor),
			{ fresh: true, expectedVersion: 1 },
		);
	});

	it.each(["agent", "skill"])(
		"refuses revoked %s permission before reading its data",
		async (selection) => {
			mocks.agentPermission.mockResolvedValue(selection !== "agent");
			mocks.skillPermission.mockResolvedValue(selection !== "skill");
			const config =
				selection === "agent"
					? { agentInstructionsInstanceId: "agent-1" }
					: { skills: [{ slug: "requirements" }] };
			expect((await problems([review(config)])).join(" ")).toContain(
				"instructions could not be verified",
			);
			expect(mocks.agent).not.toHaveBeenCalled();
			expect(mocks.skill).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		{ status: "ARCHIVED" },
		{ organizationId: "other-org" },
		{ template: { ...agent().template, instructions: "x".repeat(20_001) } },
	])(
		"rejects unavailable or oversized agent instructions: %s",
		async (override) => {
			mocks.agent.mockResolvedValue(
				override && { ...agent(), ...override },
			);
			expect(
				(
					await problems([
						review({ agentInstructionsInstanceId: "agent-1" }),
					])
				).join(" "),
			).toContain("instructions could not be verified");
		},
	);

	it("fails closed for an unpublished or inaccessible skill", async () => {
		mocks.skill.mockRejectedValue(new Error("Skill not accessible"));
		expect(
			(
				await problems([review({ skills: [{ slug: "requirements" }] })])
			).join(" "),
		).toContain("instructions could not be verified");
	});

	it.each([
		{ files: [] },
		{ files: [{ path: "references/checklist.md", sizeBytes: 20_001 }] },
		{
			skillMd: "x".repeat(40_001),
			files: [{ path: "references/checklist.md", sizeBytes: 1 }],
		},
	])(
		"enforces canonical published skill size and manifest bounds: %s",
		async (override) => {
			mocks.skill.mockResolvedValue({
				slug: "requirements",
				version: 1,
				skillMd: "Checklist",
				...override,
			});
			expect(
				(
					await problems([
						review({
							skills: [
								{
									slug: "requirements",
									textFiles: ["references/checklist.md"],
								},
							],
						}),
					])
				).length,
			).toBeGreaterThan(0);
		},
	);

	it.each([
		{ encoding: "base64", data: "AA==" },
		{ encoding: "utf-8", data: "x".repeat(20_001) },
	])("rejects binary or oversized actual file content: %s", async (file) => {
		mocks.file.mockResolvedValue(file);
		expect(
			(
				await problems([
					review({
						skills: [
							{
								slug: "requirements",
								textFiles: ["references/checklist.md"],
							},
						],
					}),
				])
			).length,
		).toBeGreaterThan(0);
	});
});

describe("review scheduling", () => {
	it.each(["* * * * *", "*/5 * * * *", "0,10 9 * * *"])(
		"requires at least 15 minutes between AI reviews: %s",
		async (cron) => {
			expect(
				(await problems([schedule(cron), review()])).join(" "),
			).toContain("at most every 15 minutes");
		},
	);
	it.each(["*/15 * * * *", "0 9 * * *"])(
		"allows a bounded schedule: %s",
		async (cron) => {
			expect(await problems([schedule(cron), review()])).toEqual([]);
		},
	);
	it("keeps the frequency guard even when review config is invalid", async () => {
		expect(
			(
				await problems([schedule("* * * * *"), review({ rubric: "" })])
			).join(" "),
		).toContain("at most every 15 minutes");
	});
});
