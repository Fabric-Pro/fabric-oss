/**
 * projects.discovery.{start,list,get,cancel,markContractComplete} (plan Slice 4)
 *
 * Run with: pnpm --filter @repo/api test modules/projects/procedures/__tests__/discovery.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<(...args: unknown[]) => unknown>,
	mocks: {
		userStoryFindFirst: vi.fn(),
		discoveryRunCreate: vi.fn(),
		discoveryRunUpdate: vi.fn(),
		discoveryRunFindFirst: vi.fn(),
		discoveryRunFindMany: vi.fn(),
		discoveryRunUpdateMany: vi.fn(),
		projectDocumentFindFirst: vi.fn(),
		projectDocumentFindMany: vi.fn(),
		projectDocumentUpdate: vi.fn(),
		getContextById: vi.fn(),
		getMcpConfigById: vi.fn(),
		workflowStart: vi.fn(),
		workflowDescribe: vi.fn(),
		workflowSignal: vi.fn(),
	},
}));

vi.mock("@repo/database", () => {
	const tx = {
		projectDocument: { update: mocks.projectDocumentUpdate },
		discoveryRun: {
			findMany: mocks.discoveryRunFindMany,
			updateMany: mocks.discoveryRunUpdateMany,
		},
	};
	return {
		db: {
			userStory: { findFirst: mocks.userStoryFindFirst },
			discoveryRun: {
				create: mocks.discoveryRunCreate,
				update: mocks.discoveryRunUpdate,
				findFirst: mocks.discoveryRunFindFirst,
				findMany: mocks.discoveryRunFindMany,
				updateMany: mocks.discoveryRunUpdateMany,
			},
			projectDocument: {
				findFirst: mocks.projectDocumentFindFirst,
				findMany: mocks.projectDocumentFindMany,
				update: mocks.projectDocumentUpdate,
			},
			$transaction: async (fn: (client: typeof tx) => Promise<unknown>) =>
				await fn(tx),
		},
		getContextById: mocks.getContextById,
		getMcpConfigById: mocks.getMcpConfigById,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: {
			start: mocks.workflowStart,
			getHandle: () => ({
				describe: mocks.workflowDescribe,
				signal: mocks.workflowSignal,
			}),
		},
	}),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	};
	return {
		resolveOrganizationIdForCaller: vi.fn(
			async (organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

// Registration order defines the handler index.
import "../discovery/start-discovery"; // 0
import "../discovery/list-discovery-runs"; // 1 list, 2 get
import "../discovery/cancel-discovery"; // 3
import "../discovery/mark-contract-complete"; // 4
import { hasCompleteIntegrationContract } from "@repo/database/src/delivery/evidence-providers";

const [start, list, get, cancel, markComplete] = handlers as Array<
	(args: { input: Record<string, unknown>; context: unknown }) => Promise<any>
>;

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const discoveryStory = {
	id: "story-1",
	identifier: "F-007",
	title: "SSO login",
	deliveryTrack: "DISCOVERY",
	project: {
		name: "Acme",
		description: null,
		techStack: [],
		organizationId: "org-1",
		repositoryUrl: "https://github.com/acme/portal",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.userStoryFindFirst.mockResolvedValue(discoveryStory);
	mocks.discoveryRunCreate.mockResolvedValue({ id: "run-1" });
	mocks.discoveryRunUpdate.mockResolvedValue({});
	mocks.discoveryRunUpdateMany.mockResolvedValue({ count: 1 });
	mocks.workflowStart.mockResolvedValue({});
});

describe("projects.discovery.start", () => {
	it("registers all five procedures", () => {
		expect(handlers).toHaveLength(5);
	});

	it("rejects a feature that is not on the DISCOVERY track with PRECONDITION_FAILED", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			...discoveryStory,
			deliveryTrack: "SPECIFY",
		});
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { repo: true },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.discoveryRunCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("rejects an OpenAPI context from another project or tenant as NOT_FOUND", async () => {
		mocks.getContextById.mockResolvedValue(null);
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { openApi: { contextId: "ctx-foreign" } },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// Tenant scope comes from the project, not the session.
		expect(mocks.getContextById).toHaveBeenCalledWith(
			"ctx-foreign",
			"proj-1",
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(mocks.discoveryRunCreate).not.toHaveBeenCalled();
	});

	it("rejects an MCP config the caller does not own as NOT_FOUND", async () => {
		mocks.getMcpConfigById.mockResolvedValue(null);
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { mcpConfigIds: ["cfg-foreign"] },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.getMcpConfigById).toHaveBeenCalledWith("cfg-foreign", {
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.discoveryRunCreate).not.toHaveBeenCalled();
	});

	it("rejects a private OpenAPI URL before creating a run", async () => {
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: {
						openApi: { url: "http://169.254.169.254/latest" },
					},
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.discoveryRunCreate).not.toHaveBeenCalled();
	});

	it("maps the one-active-per-story unique violation to CONFLICT", async () => {
		mocks.discoveryRunCreate.mockRejectedValue({
			code: "P2002",
			meta: { target: "discovery_run_one_active_per_story" },
		});
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { repo: true },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "A discovery run is already active for this feature.",
		});
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("creates the run and starts the workflow on project-documents with the deterministic id", async () => {
		mocks.getMcpConfigById.mockResolvedValue({ id: "cfg-1" });
		const result = await start({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				sources: { repo: true, mcpConfigIds: ["cfg-1", "cfg-1"] },
			},
			context: ctx,
		});
		expect(result).toEqual({
			discoveryRunId: "run-1",
			workflowId: "discovery-run-run-1",
			status: "started",
		});
		expect(mocks.discoveryRunCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: "proj-1",
					storyId: "story-1",
					userId: "user-1",
					organizationId: "org-1",
					status: "QUEUED",
					sources: { repo: true, mcpConfigIds: ["cfg-1"] },
				}),
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"discoveryRunWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				workflowId: "discovery-run-run-1",
				args: [
					expect.objectContaining({
						discoveryRunId: "run-1",
						userId: "user-1",
						organizationId: "org-1",
						sources: { repo: true, mcpConfigIds: ["cfg-1"] },
						story: { identifier: "F-007", title: "SSO login" },
					}),
				],
			}),
		);
		expect(mocks.discoveryRunUpdate).toHaveBeenCalledWith({
			where: { id: "run-1" },
			data: { workflowId: "discovery-run-run-1" },
		});
	});

	it("releases the row only when Temporal confirms no execution exists", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("connect timeout"));
		mocks.workflowDescribe.mockRejectedValue(
			Object.assign(new Error("not found"), {
				name: "WorkflowNotFoundError",
			}),
		);
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { repo: true },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.discoveryRunUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "run-1" },
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);

		// Unknown outcome: leave the row active.
		mocks.discoveryRunUpdate.mockClear();
		mocks.workflowDescribe.mockRejectedValue(new Error("unavailable"));
		await expect(
			start({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					sources: { repo: true },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.discoveryRunUpdate).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});
});

describe("projects.discovery.list / get", () => {
	it("XOR-filters on the tenant context and attaches the contract document", async () => {
		mocks.discoveryRunFindMany.mockResolvedValue([
			{
				id: "run-1",
				projectId: "proj-1",
				storyId: "story-1",
				userId: "user-1",
				organizationId: "org-1",
				status: "CONTRACT_READY",
				sources: { repo: true },
				documentId: "doc-1",
				workflowId: "discovery-run-run-1",
				error: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);
		mocks.projectDocumentFindMany.mockResolvedValue([
			{
				id: "doc-1",
				title: "Integration contract — F-007",
				status: "REVIEW",
				isActive: true,
			},
		]);
		const result = await list({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: "org-1",
				limit: 20,
			},
			context: ctx,
		});
		expect(mocks.discoveryRunFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "proj-1",
					organizationId: "org-1",
					storyId: "story-1",
				},
			}),
		);
		expect(result.runs[0].document).toEqual({
			id: "doc-1",
			title: "Integration contract — F-007",
			status: "REVIEW",
			isActive: true,
		});

		mocks.discoveryRunFindFirst.mockResolvedValue(null);
		await expect(
			get({
				input: {
					projectId: "proj-1",
					runId: "run-x",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.discoveryRunFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run-x",
					projectId: "proj-1",
					organizationId: null,
				},
			}),
		);
	});
});

describe("projects.discovery.cancel", () => {
	it("signals the deterministic workflow id and marks the row CANCELLED", async () => {
		mocks.discoveryRunFindFirst.mockResolvedValue({
			id: "run-1",
			status: "RUNNING",
			workflowId: null,
		});
		const result = await cancel({
			input: {
				projectId: "proj-1",
				runId: "run-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		expect(result).toEqual({ status: "cancelled" });
		expect(mocks.workflowSignal).toHaveBeenCalledWith("cancelDiscovery");
		// Compare-and-swap from an active status: never an unconditional
		// update that could overwrite a concurrent CONTRACT_READY/COMPLETED.
		expect(mocks.discoveryRunUpdate).not.toHaveBeenCalled();
		expect(mocks.discoveryRunUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "run-1",
				status: { in: ["QUEUED", "RUNNING", "CONTRACT_READY"] },
			},
			data: { status: "CANCELLED" },
		});
	});

	it("returns CONFLICT when the run left the active set between read and write", async () => {
		mocks.discoveryRunFindFirst.mockResolvedValue({
			id: "run-1",
			status: "RUNNING",
			workflowId: null,
		});
		mocks.discoveryRunUpdateMany.mockResolvedValue({ count: 0 });
		await expect(
			cancel({
				input: {
					projectId: "proj-1",
					runId: "run-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("surfaces a Temporal outage instead of marking the row cancelled", async () => {
		mocks.discoveryRunFindFirst.mockResolvedValue({
			id: "run-1",
			status: "RUNNING",
			workflowId: "discovery-run-run-1",
		});
		mocks.workflowSignal.mockRejectedValue(new Error("unavailable"));
		await expect(
			cancel({
				input: {
					projectId: "proj-1",
					runId: "run-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.discoveryRunUpdate).not.toHaveBeenCalled();

		mocks.workflowSignal.mockRejectedValue(
			Object.assign(new Error("gone"), { name: "WorkflowNotFoundError" }),
		);
		await expect(
			cancel({
				input: {
					projectId: "proj-1",
					runId: "run-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).resolves.toEqual({ status: "cancelled" });
	});

	it("refuses to cancel a finished run", async () => {
		mocks.discoveryRunFindFirst.mockResolvedValue({
			id: "run-1",
			status: "COMPLETED",
			workflowId: null,
		});
		await expect(
			cancel({
				input: {
					projectId: "proj-1",
					runId: "run-1",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("projects.discovery.markContractComplete", () => {
	it("sets the document COMPLETE, closes the run, and the evidence provider then reports the gate satisfied", async () => {
		mocks.projectDocumentFindFirst.mockResolvedValue({
			id: "doc-1",
			storyId: "story-1",
			status: "REVIEW",
			isActive: true,
		});
		mocks.discoveryRunFindMany.mockResolvedValue([{ id: "run-1" }]);

		const result = await markComplete({
			input: {
				projectId: "proj-1",
				documentId: "doc-1",
				organizationId: "org-1",
			},
			context: ctx,
		});
		expect(result).toEqual({
			documentId: "doc-1",
			storyId: "story-1",
			status: "COMPLETE",
			completedRunIds: ["run-1"],
		});
		expect(mocks.projectDocumentUpdate).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: { status: "COMPLETE", lastEditedBy: "user-1" },
		});
		expect(mocks.discoveryRunUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ["run-1"] } },
			data: { status: "COMPLETED" },
		});

		// The readiness evidence provider (real module) reads the same shape
		// the procedure just wrote: an active COMPLETE contract for the story.
		const store = new Map([
			[
				"doc-1",
				{
					id: "doc-1",
					storyId: "story-1",
					projectId: "proj-1",
					type: "INTEGRATION_CONTRACT",
					status: "COMPLETE",
					isActive: true,
				},
			],
		]);
		const client = {
			projectDocument: {
				findFirst: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) =>
					[...store.values()].find(
						(doc) =>
							doc.storyId === where.storyId &&
							doc.projectId === where.projectId &&
							doc.type === where.type &&
							doc.status === where.status &&
							doc.isActive === where.isActive,
					) ?? null,
			},
		} as never;
		await expect(
			hasCompleteIntegrationContract(client, {
				storyId: "story-1",
				projectId: "proj-1",
			}),
		).resolves.toBe(true);
		const current = store.get("doc-1");
		if (!current) {
			throw new Error("fixture missing");
		}
		store.set("doc-1", { ...current, status: "REVIEW" });
		await expect(
			hasCompleteIntegrationContract(client, {
				storyId: "story-1",
				projectId: "proj-1",
			}),
		).resolves.toBe(false);
	});

	it("rejects a superseded (inactive) or unlinked contract", async () => {
		mocks.projectDocumentFindFirst.mockResolvedValue({
			id: "doc-old",
			storyId: "story-1",
			status: "REVIEW",
			isActive: false,
		});
		await expect(
			markComplete({
				input: {
					projectId: "proj-1",
					documentId: "doc-old",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		mocks.projectDocumentFindFirst.mockResolvedValue(null);
		await expect(
			markComplete({
				input: {
					projectId: "proj-1",
					documentId: "doc-x",
					organizationId: "org-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.projectDocumentUpdate).not.toHaveBeenCalled();
	});
});
