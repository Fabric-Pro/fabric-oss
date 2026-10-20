import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeFrame {
	id: string;
	userId: string;
	organizationId: string;
	projectId: string | undefined;
	title: string;
	surface: string | undefined;
	sourceRunId: string | undefined;
	sourceNodeId: string | undefined;
	document: { blocks: Array<{ content: string }> };
}

const store = vi.hoisted(() => ({
	frames: new Map<string, unknown>(),
	workflowSettings: null as unknown,
	nextId: 1,
}));

const database = vi.hoisted(() => ({
	canCreateOrganizationFrames: vi.fn(),
	canUpdateOrganizationFrames: vi.fn(),
	projectPlacementRefusal: vi.fn(),
	saveFullUpdateToHistory: vi.fn(),
	createFrame: vi.fn(),
	updateFrame: vi.fn(),
	getFrameById: vi.fn(),
	findFrameForSourceRun: vi.fn(),
	workflowFindFirst: vi.fn(),
	writeWorkflowRunState: vi.fn(),
	organizationFindUnique: vi.fn(),
	queryRaw: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canCreateOrganizationFrames: database.canCreateOrganizationFrames,
	canUpdateOrganizationFrames: database.canUpdateOrganizationFrames,
	projectPlacementRefusal: database.projectPlacementRefusal,
	saveFullUpdateToHistory: database.saveFullUpdateToHistory,
	createFrame: database.createFrame,
	updateFrame: database.updateFrame,
	getFrameById: database.getFrameById,
	findFrameForSourceRun: database.findFrameForSourceRun,
	writeWorkflowRunState: database.writeWorkflowRunState,
	db: {
		organization: { findUnique: database.organizationFindUnique },
		workflow: {
			findFirst: database.workflowFindFirst,
		},
		$transaction: async (
			run: (tx: unknown) => Promise<unknown>,
		): Promise<unknown> =>
			run({
				$queryRaw: database.queryRaw,
				workflow: {
					findFirst: database.workflowFindFirst,
				},
			}),
	},
}));

import type { StepParams } from "../../../types";
import {
	executePublishFrameStep,
	PUBLISH_FRAME_MAX_CONTENT_CHARS,
} from "../publish-frame";

const PAGE_ONE = "<html><body>week one</body></html>";
const PAGE_TWO = "<html><body>week two</body></html>";

function frames(): FakeFrame[] {
	return [...store.frames.values()] as FakeFrame[];
}

function params(overrides: Partial<StepParams> = {}): StepParams {
	return {
		nodeConfig: {
			title: "Weekly status",
			content: "{{Agent Task.html}}",
		},
		inputs: { "Agent Task": { html: PAGE_ONE } },
		userId: "user-1",
		organizationId: "org-1",
		projectId: "proj-1",
		workflowId: "wf-1",
		executionId: "exec-1",
		nodeId: "publish-frame",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	store.frames.clear();
	store.workflowSettings = null;
	store.nextId = 1;

	database.canCreateOrganizationFrames.mockResolvedValue(true);
	database.canUpdateOrganizationFrames.mockResolvedValue(true);
	database.projectPlacementRefusal.mockResolvedValue(null);
	database.organizationFindUnique.mockResolvedValue({ slug: "example-org" });
	database.queryRaw.mockResolvedValue([]);

	database.createFrame.mockImplementation(async (input) => {
		const frame: FakeFrame = {
			id: `frame-${store.nextId++}`,
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			title: input.title,
			surface: input.surface,
			sourceRunId: input.sourceRunId,
			sourceNodeId: input.sourceNodeId,
			document: { blocks: input.blocks },
		};
		store.frames.set(frame.id, frame);
		return frame;
	});
	database.findFrameForSourceRun.mockImplementation(
		async (input) =>
			frames().find(
				(frame) =>
					frame.userId === input.userId &&
					frame.organizationId === input.organizationId &&
					(frame.projectId ?? null) === input.projectId &&
					frame.sourceRunId === input.sourceRunId &&
					frame.sourceNodeId === input.sourceNodeId,
			) ?? null,
	);
	database.getFrameById.mockImplementation(
		async (input) =>
			frames().find(
				(frame) =>
					frame.id === input.id &&
					frame.userId === input.userId &&
					frame.organizationId === input.organizationId,
			) ?? null,
	);
	database.updateFrame.mockImplementation(async (input) => {
		const frame = store.frames.get(input.id) as FakeFrame | undefined;
		if (!frame) {
			return null;
		}
		frame.title = input.title ?? frame.title;
		frame.document = { blocks: input.blocks ?? frame.document.blocks };
		return frame;
	});
	database.workflowFindFirst.mockImplementation(async () => ({
		settings: store.workflowSettings,
	}));
	database.writeWorkflowRunState.mockImplementation(
		async (_tx, { settings }) => {
			store.workflowSettings = settings;
			return 1;
		},
	);
});

describe("executePublishFrameStep - creating", () => {
	it("publishes the upstream html as an artifact frame in the project", async () => {
		const result = await executePublishFrameStep(params());

		expect(result).toEqual({
			success: true,
			output: {
				frameId: "frame-1",
				title: "Weekly status",
				url: "/app/example-org/frames/frame-1",
				action: "created",
			},
		});
		expect(database.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				surface: "artifact",
				sourceRunType: "workflow",
				sourceRunId: "exec-1",
				sourceNodeId: "publish-frame",
				blocks: [
					{
						id: "content",
						type: "html",
						title: "Weekly status",
						content: PAGE_ONE,
					},
				],
			}),
		);
	});

	it("creates the frame once however often the step is retried", async () => {
		const first = await executePublishFrameStep(params());
		const retry = await executePublishFrameStep(params());

		expect(database.createFrame).toHaveBeenCalledOnce();
		expect(frames()).toHaveLength(1);
		expect(retry.output?.frameId).toBe(first.output?.frameId);
		expect(retry.output?.action).toBe("unchanged");
	});

	it("keeps two publish nodes of one run apart", async () => {
		await executePublishFrameStep(params({ nodeId: "publish-a" }));
		await executePublishFrameStep(
			params({
				nodeId: "publish-b",
				inputs: { "Agent Task": { html: PAGE_TWO } },
			}),
		);

		expect(frames()).toHaveLength(2);
	});

	it("publishes markdown as a markdown block", async () => {
		await executePublishFrameStep(
			params({
				nodeConfig: {
					title: "Notes",
					content: "{{Agent Task.markdown}}",
					format: "markdown",
				},
				inputs: { "Agent Task": { markdown: "# Notes" } },
			}),
		);

		expect(database.createFrame.mock.calls[0][0].blocks[0]).toMatchObject({
			type: "markdown",
			content: "# Notes",
		});
	});

	it("fills the title from upstream output", async () => {
		const result = await executePublishFrameStep(
			params({
				nodeConfig: {
					title: "Status {{Agent Task.week}}",
					content: "{{Agent Task.html}}",
				},
				inputs: { "Agent Task": { html: PAGE_ONE, week: "42" } },
			}),
		);

		expect(result.output?.title).toBe("Status 42");
	});

	it("falls back to the workflow's project and lets the node override it", async () => {
		await executePublishFrameStep(params({ projectId: "wf-project" }));
		await executePublishFrameStep(
			params({
				projectId: "wf-project",
				executionId: "exec-2",
				nodeConfig: {
					title: "T",
					content: "{{Agent Task.html}}",
					projectId: "node-project",
				},
			}),
		);

		expect(database.createFrame.mock.calls[0][0].projectId).toBe(
			"wf-project",
		);
		expect(database.createFrame.mock.calls[1][0].projectId).toBe(
			"node-project",
		);
	});
});

describe("executePublishFrameStep - new-version mode", () => {
	it("updates the same frame on a later run and leaves the history to updateFrame", async () => {
		const first = await executePublishFrameStep(params());

		const second = await executePublishFrameStep(
			params({
				executionId: "exec-2",
				inputs: { "Agent Task": { html: PAGE_TWO } },
			}),
		);

		expect(frames()).toHaveLength(1);
		expect(second.output).toMatchObject({
			frameId: first.output?.frameId,
			action: "updated",
		});
		expect(frames()[0].document.blocks[0].content).toBe(PAGE_TWO);
		expect(database.updateFrame).toHaveBeenCalledOnce();
		expect(database.updateFrame.mock.calls[0][0]).toMatchObject({
			id: first.output?.frameId,
		});
		expect(database.saveFullUpdateToHistory).not.toHaveBeenCalled();
		expect(store.workflowSettings).toEqual({
			publishFrameIds: { "publish-frame": first.output?.frameId },
		});
		expect(database.writeWorkflowRunState).toHaveBeenCalledTimes(1);
		expect(database.writeWorkflowRunState).toHaveBeenCalledWith(
			expect.anything(),
			{
				workflowId: "wf-1",
				organizationId: "org-1",
				settings: {
					publishFrameIds: { "publish-frame": first.output?.frameId },
				},
			},
		);
	});

	it("does not add a version when the page did not change", async () => {
		await executePublishFrameStep(params());
		database.writeWorkflowRunState.mockClear();

		const second = await executePublishFrameStep(
			params({ executionId: "exec-2" }),
		);

		expect(second.output?.action).toBe("unchanged");
		expect(database.updateFrame).not.toHaveBeenCalled();
		expect(database.saveFullUpdateToHistory).not.toHaveBeenCalled();
		expect(database.writeWorkflowRunState).not.toHaveBeenCalled();
	});

	it("preserves other settings when it records the frame id", async () => {
		store.workflowSettings = { consecutiveFailures: 1 };

		await executePublishFrameStep(params());

		expect(store.workflowSettings).toEqual({
			consecutiveFailures: 1,
			publishFrameIds: { "publish-frame": "frame-1" },
		});
	});

	it("creates a new frame and replaces the id when the kept frame is gone", async () => {
		store.workflowSettings = {
			publishFrameIds: { "publish-frame": "deleted" },
		};

		const result = await executePublishFrameStep(params());

		expect(result.output).toMatchObject({
			frameId: "frame-1",
			action: "created",
		});
		expect(store.workflowSettings).toEqual({
			publishFrameIds: { "publish-frame": "frame-1" },
		});
	});

	it("does not update a frame that belongs to someone else", async () => {
		store.frames.set("foreign", {
			id: "foreign",
			userId: "someone-else",
			organizationId: "org-1",
			projectId: "proj-1",
			title: "Theirs",
			document: { blocks: [{ content: "private" }] },
		});
		store.workflowSettings = {
			publishFrameIds: { "publish-frame": "foreign" },
		};

		const result = await executePublishFrameStep(params());

		expect(database.updateFrame).not.toHaveBeenCalled();
		expect(result.output?.action).toBe("created");
		expect((store.frames.get("foreign") as FakeFrame).title).toBe("Theirs");
	});

	it("starts a new frame when the project changed", async () => {
		await executePublishFrameStep(params());

		const result = await executePublishFrameStep(
			params({ executionId: "exec-2", projectId: "proj-2" }),
		);

		expect(result.output?.action).toBe("created");
		expect(frames()).toHaveLength(2);
	});
});

describe("executePublishFrameStep - new-frame mode", () => {
	it("creates a frame per run and keeps no settings", async () => {
		const nodeConfig = {
			title: "Daily",
			content: "{{Agent Task.html}}",
			mode: "new-frame",
		};

		await executePublishFrameStep(params({ nodeConfig }));
		await executePublishFrameStep(
			params({ nodeConfig, executionId: "exec-2" }),
		);

		expect(frames()).toHaveLength(2);
		expect(database.writeWorkflowRunState).not.toHaveBeenCalled();
	});

	it("still creates only one frame when a run's step is retried", async () => {
		const nodeConfig = {
			title: "Daily",
			content: "{{Agent Task.html}}",
			mode: "new-frame",
		};

		await executePublishFrameStep(params({ nodeConfig }));
		await executePublishFrameStep(params({ nodeConfig }));

		expect(frames()).toHaveLength(1);
	});
});

describe("executePublishFrameStep - refusals", () => {
	it("refuses an artifact with no project", async () => {
		const result = await executePublishFrameStep(
			params({ projectId: undefined }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("needs a project");
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("lets a workspace frame stand without a project", async () => {
		const result = await executePublishFrameStep(
			params({
				projectId: undefined,
				nodeConfig: {
					title: "Board",
					content: "{{Agent Task.html}}",
					surface: "workspace",
				},
			}),
		);

		expect(result.success).toBe(true);
		expect(database.projectPlacementRefusal).not.toHaveBeenCalled();
		expect(database.createFrame.mock.calls[0][0]).toMatchObject({
			surface: "workspace",
			projectId: undefined,
		});
	});

	it("asks the shared placement check about the owner, the organization and the project", async () => {
		await executePublishFrameStep(params());

		expect(
			database.projectPlacementRefusal,
		).toHaveBeenCalledExactlyOnceWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
		});
	});

	it("refuses a project the placement check reports missing (another organization, no access, or in the trash)", async () => {
		database.projectPlacementRefusal.mockResolvedValue("not_found");

		const result = await executePublishFrameStep(params());

		expect(result.success).toBe(false);
		expect(result.error).toContain("does not exist or is not accessible");
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("refuses to update the frame it kept when the project has since been trashed", async () => {
		await executePublishFrameStep(params());
		database.projectPlacementRefusal.mockResolvedValue("not_found");

		const result = await executePublishFrameStep(
			params({
				executionId: "exec-2",
				inputs: { "Agent Task": { html: PAGE_TWO } },
			}),
		);

		expect(result.success).toBe(false);
		expect(database.updateFrame).not.toHaveBeenCalled();
	});

	it("refuses a project the owner may read but not edit", async () => {
		database.projectPlacementRefusal.mockResolvedValue("not_editable");

		const result = await executePublishFrameStep(params());

		expect(result.success).toBe(false);
		expect(result.error).toContain("No permission");
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("refuses an owner who may not create frames in the organization", async () => {
		database.canCreateOrganizationFrames.mockResolvedValue(false);

		const result = await executePublishFrameStep(params());

		expect(result.success).toBe(false);
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("refuses to update when the owner may no longer update frames", async () => {
		await executePublishFrameStep(params());
		database.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await executePublishFrameStep(
			params({
				executionId: "exec-2",
				inputs: { "Agent Task": { html: PAGE_TWO } },
			}),
		);

		expect(result.success).toBe(false);
		expect(database.updateFrame).not.toHaveBeenCalled();
		expect(frames()[0].document.blocks[0].content).toBe(PAGE_ONE);
	});

	it("scopes every frame lookup to the run's organization", async () => {
		await executePublishFrameStep(params());
		await executePublishFrameStep(params({ executionId: "exec-2" }));

		for (const [input] of database.getFrameById.mock.calls) {
			expect(input.organizationId).toBe("org-1");
		}
		for (const [input] of database.findFrameForSourceRun.mock.calls) {
			expect(input.organizationId).toBe("org-1");
		}
		expect(
			database.workflowFindFirst.mock.calls.every(
				([query]) => query.where.organizationId === "org-1",
			),
		).toBe(true);
	});

	it("needs an organization", async () => {
		const result = await executePublishFrameStep(
			params({ organizationId: undefined }),
		);

		expect(result.success).toBe(false);
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("will not publish nothing", async () => {
		const result = await executePublishFrameStep(
			params({ inputs: { "Agent Task": { text: "no html here" } } }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("{{Agent Task.html}}");
		expect(database.createFrame).not.toHaveBeenCalled();
	});

	it("refuses content too large to store as a frame", async () => {
		const result = await executePublishFrameStep(
			params({
				inputs: {
					"Agent Task": {
						html: "x".repeat(PUBLISH_FRAME_MAX_CONTENT_CHARS + 1),
					},
				},
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("too large");
	});

	it("rejects an invalid configuration", async () => {
		const result = await executePublishFrameStep(
			params({ nodeConfig: { title: "", content: "x" } }),
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid Publish Frame configuration");
	});

	it("reports a storage failure as a failed step", async () => {
		database.createFrame.mockRejectedValue(new Error("db down"));

		const result = await executePublishFrameStep(params());

		expect(result).toMatchObject({
			success: false,
			error: "Publish Frame failed: db down",
		});
	});
});
