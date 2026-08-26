/**
 * Unit tests for `applyChangesProcedure` proposal-row write-up-front extension.
 *
 * Covered surfaces:
 *   - Row is created BEFORE the workflow start (call-order assertion against
 *     the mocked Temporal client).
 *   - Returned `proposalId` matches the persisted row id.
 *   - Payload-too-large guard rejects > 1 MB approvedChanges with
 *     RESOURCE_EXHAUSTED — no row written, no workflow start.
 *   - Tenant XOR — the row is created with the resolved organizationId +
 *     callers userId; never with mixed tenants.
 *
 * Boundaries mocked: `@repo/database` (just the helpers we touch),
 * `@repo/temporal`, the oRPC procedure chain. The procedure handler is
 * captured via the chain mock's `.handler(fn)` hook.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindUnique: vi.fn(),
		architectureDecisionFindMany: vi.fn(),
		createPendingBacklogProposal: vi.fn(),
		pendingBacklogProposalUpdate: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowStart: vi.fn(),
		recordAuditFromRequest: vi.fn(),
		runDecisionPrecheck: vi.fn(),
		callOrder: [] as string[],
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		architectureDecision: {
			findMany: (...args: unknown[]) =>
				mocks.architectureDecisionFindMany(...args),
		},
		pendingBacklogProposal: {
			update: (...args: unknown[]) => {
				mocks.callOrder.push("pendingBacklogProposal.update");
				return mocks.pendingBacklogProposalUpdate(...args);
			},
		},
	},
	markProposalApplyDispatched: () => Promise.resolve(),
	createPendingBacklogProposal: (...args: unknown[]) => {
		mocks.callOrder.push("createPendingBacklogProposal");
		return mocks.createPendingBacklogProposal(...args);
	},
	Prisma: {},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
	// Apply-time authoritative pre-check: run on EVERY apply (client input is
	// never trusted for the override log). Defaults to a clean "ok"; the
	// override-logging tests seed conflicts via `serverJudge(...)`.
	runDecisionPrecheck: (...args: unknown[]) =>
		mocks.runDecisionPrecheck(...args),
}));

// The real `recordDecisionOverridesAccepted` helper runs (mirroring the
// acknowledge-procedure test); only the terminal `recordAuditFromRequest`
// boundary is mocked so we assert the emitted override rows directly.
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["applyChanges"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../apply-changes");

const ctx = { user: { id: "user-1" }, session: {} };

const baseChange = {
	type: "feature" as const,
	action: "create" as const,
	title: { to: "Add login form" },
	reasoning: "User requested",
	sourceContext: "teams_messages" as const,
};

const baseInput = {
	projectId: "project-1",
	organizationId: "org-1",
	approvedChanges: [baseChange],
	syncToPM: false,
};

beforeEach(() => {
	for (const key of Object.keys(mocks)) {
		const m = mocks[key as keyof typeof mocks];
		if (typeof m === "function" && "mockReset" in m) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.callOrder.length = 0;
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
		projectManagementContainerName: null,
	});
	// The server-judged findings are re-resolved against the project's real
	// decisions. Default to both dec-1 and dec-2 existing (ACCEPTED) so the
	// override write proceeds; individual tests narrow this to prove drops or
	// exercise the REJECTED conflictType derivation.
	mocks.architectureDecisionFindMany.mockResolvedValue([
		{
			id: "dec-1",
			identifier: "ADR-012",
			title: "Use Postgres",
			status: "ACCEPTED",
		},
		{
			id: "dec-2",
			identifier: "ADR-2",
			title: "Use Redis",
			status: "ACCEPTED",
		},
	]);
	mocks.createPendingBacklogProposal.mockResolvedValue({
		id: "proposal-new-1",
	});
	mocks.pendingBacklogProposalUpdate.mockResolvedValue({
		id: "proposal-new-1",
	});
	mocks.workflowStart.mockResolvedValue({
		workflowId: "wf-1",
		firstExecutionRunId: "run-1",
	});
	// Default: the apply-time authoritative check (run on EVERY apply) finds
	// nothing — the clean path. The override-logging tests override this per case
	// via `serverJudge(...)`.
	mocks.runDecisionPrecheck.mockResolvedValue({
		checkedAt: "2020-01-01T00:00:00.000Z",
		status: "ok",
		findings: [],
	});
	mocks.getTemporalClient.mockImplementation(async () => ({
		workflow: {
			start: (...args: unknown[]) => {
				mocks.callOrder.push("workflow.start");
				return mocks.workflowStart(...args);
			},
		},
	}));
});

describe("applyChangesProcedure — proposal row up-front (AC #1)", () => {
	it("creates the PendingBacklogProposal row BEFORE starting the workflow", async () => {
		await handlers.applyChanges({ input: baseInput, context: ctx });

		expect(mocks.callOrder).toEqual([
			"createPendingBacklogProposal",
			"workflow.start",
		]);
	});

	it("returns the persisted proposal id", async () => {
		const result = (await handlers.applyChanges({
			input: baseInput,
			context: ctx,
		})) as { proposalId: string };
		expect(result.proposalId).toBe("proposal-new-1");
	});

	it("threads pendingProposalId into the workflow input", async () => {
		await handlers.applyChanges({ input: baseInput, context: ctx });
		const startArgs = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ pendingProposalId?: string }>;
		};
		expect(startArgs.args[0]?.pendingProposalId).toBe("proposal-new-1");
	});

	it("snapshots syncToPM, pmConfig, conversationId on sourceMetadata", async () => {
		await handlers.applyChanges({
			input: {
				...baseInput,
				syncToPM: true,
				pmConfig: {
					mcpConfigId: "mcp-1",
					containerId: "container-1",
				},
				conversationId: "conv-1",
			},
			context: ctx,
		});
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "AI_UPDATE_SIDEBAR",
				changeCount: 1,
				sourceMetadata: expect.objectContaining({
					syncToPM: true,
					pmConfig: expect.objectContaining({ mcpConfigId: "mcp-1" }),
					conversationId: "conv-1",
				}),
			}),
		);
	});

	it("returns null proposalId on empty approvedChanges short-circuit (no row, no workflow)", async () => {
		const result = (await handlers.applyChanges({
			input: { ...baseInput, approvedChanges: [] },
			context: ctx,
		})) as { proposalId: string | null; workflowId: string | null };
		expect(result.proposalId).toBeNull();
		expect(result.workflowId).toBeNull();
		expect(mocks.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("applyChangesProcedure — payload-too-large guard", () => {
	it("rejects > 1MB approvedChanges with RESOURCE_EXHAUSTED, no row written", async () => {
		// Build a change payload above the 1 MB serialization cap.
		const huge = "x".repeat(1_100_000);
		const giantChange = {
			...baseChange,
			title: { to: huge },
		};
		await expect(
			handlers.applyChanges({
				input: { ...baseInput, approvedChanges: [giantChange] },
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "RESOURCE_EXHAUSTED",
			message: expect.stringContaining("Batch too large"),
		});
		expect(mocks.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("applyChangesProcedure — tenant XOR", () => {
	it("stamps the row with the resolved organizationId + callers userId", async () => {
		await handlers.applyChanges({
			input: { ...baseInput, organizationId: "org-A" },
			context: { user: { id: "user-A" }, session: {} },
		});
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-A",
				userId: "user-A",
			}),
		);
	});

	it("falls back to project.organizationId when input organizationId is null", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "fallback-org",
			projectManagementContainerName: null,
		});
		await handlers.applyChanges({
			input: { ...baseInput, organizationId: null },
			context: { user: { id: "user-A" }, session: {} },
		});
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "fallback-org",
				userId: "user-A",
			}),
		);
	});
});

describe("applyChangesProcedure — failure modes", () => {
	it("throws NOT_FOUND when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		await expect(
			handlers.applyChanges({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.createPendingBacklogProposal).not.toHaveBeenCalled();
	});

	it("propagates workflow-start failure as INTERNAL_SERVER_ERROR", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("temporal down"));
		await expect(
			handlers.applyChanges({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
	});

	it("marks the proposal row as FAILED when workflow start fails", async () => {
		// Without this safety net, the row would be stuck PENDING with no
		// workflow ever flipping it — leaking as a perpetually-pending
		// proposal that the user couldn't retry or dismiss.
		mocks.workflowStart.mockRejectedValue(new Error("temporal down"));
		await expect(
			handlers.applyChanges({ input: baseInput, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.pendingBacklogProposalUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proposal-new-1" },
				data: expect.objectContaining({
					status: "FAILED",
					errorClass: "TemporalScheduleFailed",
				}),
			}),
		);
	});
});

describe("applyChangesProcedure — decision override logging", () => {
	// The override log is driven by the SERVER's own re-judge at apply time
	// (#2001) — never client input. Each test seeds the mocked judge with the
	// findings it should discover; `changeRef.index` is the finding's position in
	// `approvedChanges` (the judge runs on that exact list).
	// `resolveAppliedDecisionConflicts` then re-resolves each finding against the
	// project's real decisions before anything is persisted/audited.
	const serverJudge = (findings: unknown[]) =>
		mocks.runDecisionPrecheck.mockResolvedValueOnce({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings,
		});

	const finding = (overrides: Record<string, unknown> = {}) => ({
		decisionId: "dec-1",
		decisionIdentifier: "ADR-012",
		decisionTitle: "Use Postgres",
		natureOfConflict:
			"Proposes MongoDB, contradicting the Postgres decision",
		conflictType: "violates_accepted",
		confidence: 0.9,
		changeRef: { index: 0, title: "Adopt MongoDB" },
		...overrides,
	});

	const conflictChange = {
		...baseChange,
		title: { to: "Adopt MongoDB" },
		description: { to: "Switch the store to MongoDB" },
	};

	const conflictsInput = {
		...baseInput,
		approvedChanges: [conflictChange],
	};

	it("persists the server-detected pre-check into sourceMetadata.decisionPrecheck", async () => {
		serverJudge([finding()]);
		await handlers.applyChanges({ input: conflictsInput, context: ctx });
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				decisionPrecheck: expect.objectContaining({
					status: "conflicts",
					findings: expect.arrayContaining([
						expect.objectContaining({ decisionId: "dec-1" }),
					]),
				}),
			}),
		);
	});

	it("writes one immutable override record per conflicting decision, sharing the new proposal id", async () => {
		serverJudge([
			finding({
				decisionId: "dec-1",
				decisionIdentifier: "ADR-1",
				changeRef: { index: 0, title: "Adopt MongoDB" },
			}),
			finding({
				decisionId: "dec-2",
				decisionIdentifier: "ADR-2",
				changeRef: { index: 1, title: "Adopt Redis cache" },
			}),
		]);
		await handlers.applyChanges({
			input: {
				...conflictsInput,
				approvedChanges: [
					conflictChange,
					{ ...baseChange, title: { to: "Adopt Redis cache" } },
				],
			},
			context: ctx,
		});

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(2);
		const artifactIds = mocks.recordAuditFromRequest.mock.calls.map(
			(call) =>
				(call[1] as { metadata: { artifactId: string } }).metadata
					.artifactId,
		);
		expect(artifactIds).toEqual(["proposal-new-1", "proposal-new-1"]);
		const decisionIds = mocks.recordAuditFromRequest.mock.calls.map(
			(call) => (call[1] as { resource: { id: string } }).resource.id,
		);
		expect(decisionIds).toEqual(["dec-1", "dec-2"]);
	});

	it("builds the override snapshot from the matching approved change", async () => {
		serverJudge([finding()]);
		await handlers.applyChanges({ input: conflictsInput, context: ctx });
		const auditInput = mocks.recordAuditFromRequest.mock.calls[0]?.[1] as {
			action: string;
			metadata: { surface: string; outputSnapshot: string };
		};
		expect(auditInput.action).toBe("decision.override_accepted");
		expect(auditInput.metadata.surface).toBe("backlog_proposal");
		expect(auditInput.metadata.outputSnapshot).toBe(
			"Adopt MongoDB\n\nSwitch the store to MongoDB",
		);
	});

	it("logs the override only after the proposal row is created", async () => {
		serverJudge([finding()]);
		await handlers.applyChanges({ input: conflictsInput, context: ctx });
		// Row exists before the override write (it supplies the shared artifactId).
		expect(mocks.callOrder).toEqual([
			"createPendingBacklogProposal",
			"workflow.start",
		]);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the server judge finds no conflict", async () => {
		// Default mock returns a clean "ok".
		await handlers.applyChanges({ input: baseInput, context: ctx });
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({ decisionPrecheck: undefined }),
		);
	});

	it("logs one override for the conflicting applied change, snapshotting THAT change by title", async () => {
		// The judge flags only the MongoDB change among the applied set;
		// correlation to the snapshot is by the stable title.
		const change1 = { ...baseChange, title: { to: "Add SSO login" } };
		const change3 = {
			...baseChange,
			title: { to: "Adopt MongoDB" },
			description: { to: "Switch the store to MongoDB" },
		};
		serverJudge([
			finding({ changeRef: { index: 1, title: "Adopt MongoDB" } }),
		]);
		await handlers.applyChanges({
			input: {
				...baseInput,
				approvedChanges: [change1, change3],
			},
			context: ctx,
		});

		// Exactly one override, snapshotting the MongoDB change's content.
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const auditInput = mocks.recordAuditFromRequest.mock.calls[0]?.[1] as {
			metadata: { outputSnapshot: string };
		};
		expect(auditInput.metadata.outputSnapshot).toBe(
			"Adopt MongoDB\n\nSwitch the store to MongoDB",
		);
		// And it is persisted with exactly the surviving finding.
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				decisionPrecheck: expect.objectContaining({
					status: "conflicts",
					findings: [
						expect.objectContaining({ decisionId: "dec-1" }),
					],
				}),
			}),
		);
	});

	it("drops a finding whose change is not among the approved changes (defensive title filter)", async () => {
		// The judge runs on approvedChanges, but a finding whose title correlates
		// to no applied change must never produce an override row.
		const change1 = { ...baseChange, title: { to: "Add SSO login" } };
		const change2 = { ...baseChange, title: { to: "Add audit export" } };
		serverJudge([
			finding({ changeRef: { index: 0, title: "Adopt MongoDB" } }),
		]);
		await handlers.applyChanges({
			input: {
				...baseInput,
				approvedChanges: [change1, change2],
			},
			context: ctx,
		});

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({ decisionPrecheck: undefined }),
		);
	});

	it("remaps a finding's changeRef.index to the title-matched position in approvedChanges", async () => {
		// Defensive: even if the judge stamps a mismatched index (5), the persisted
		// finding's index is corrected to the position of the title-matched change
		// (MongoDB sits at approvedChanges[1]) so per-change consumers don't orphan.
		const change1 = { ...baseChange, title: { to: "Add SSO login" } };
		const change3 = {
			...baseChange,
			title: { to: "Adopt MongoDB" },
			description: { to: "Switch the store to MongoDB" },
		};
		serverJudge([
			finding({ changeRef: { index: 5, title: "Adopt MongoDB" } }),
		]);
		await handlers.applyChanges({
			input: {
				...baseInput,
				approvedChanges: [change1, change3],
			},
			context: ctx,
		});

		const persisted = mocks.createPendingBacklogProposal.mock
			.calls[0]?.[0] as {
			decisionPrecheck: {
				findings: Array<{
					changeRef?: { index: number; title?: string };
				}>;
			};
		};
		expect(persisted.decisionPrecheck.findings[0]?.changeRef).toEqual({
			index: 1,
			title: "Adopt MongoDB",
		});
	});

	it("re-derives conflictType from the resolved decision status, ignoring the judge's guess", async () => {
		// The decision is REJECTED; the judge guessed "violates_accepted". The
		// server re-derives it as "reintroduces_rejected" from the DB status.
		mocks.architectureDecisionFindMany.mockResolvedValue([
			{
				id: "dec-1",
				identifier: "ADR-012",
				title: "Use Postgres",
				status: "REJECTED",
			},
		]);
		serverJudge([finding({ conflictType: "violates_accepted" })]);
		await handlers.applyChanges({ input: conflictsInput, context: ctx });

		const auditInput = mocks.recordAuditFromRequest.mock.calls[0]?.[1] as {
			metadata: { conflictType: string };
		};
		expect(auditInput.metadata.conflictType).toBe("reintroduces_rejected");
	});

	it("drops a finding whose decisionId is not a real project decision", async () => {
		// The project has only dec-1; a finding referencing dec-forged must be
		// dropped before anything is persisted or written to the override ledger.
		mocks.architectureDecisionFindMany.mockResolvedValue([
			{ id: "dec-1", identifier: "ADR-012", title: "Use Postgres" },
		]);
		serverJudge([
			finding({
				decisionId: "dec-forged",
				decisionIdentifier: "ADR-999",
				changeRef: { index: 0, title: "Adopt MongoDB" },
			}),
		]);
		await handlers.applyChanges({ input: conflictsInput, context: ctx });

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.createPendingBacklogProposal).toHaveBeenCalledWith(
			expect.objectContaining({ decisionPrecheck: undefined }),
		);
	});
});

describe("applyChangesProcedure — server-authoritative pre-check (cannot be suppressed by the client)", () => {
	// The override log is driven ONLY by the server's own re-judge at apply time,
	// so the fast-apply / chat "skip analysis" / forged-relay paths can't reach the
	// backlog with a suppressed contradiction record.
	const conflictChange = {
		...baseChange,
		title: { to: "Adopt MongoDB" },
		description: { to: "Switch the store to MongoDB" },
	};

	it("ALWAYS runs the judge server-side and logs the override it finds", async () => {
		mocks.runDecisionPrecheck.mockResolvedValueOnce({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings: [
				{
					decisionId: "dec-1",
					decisionIdentifier: "ADR-012",
					decisionTitle: "Use Postgres",
					natureOfConflict:
						"Proposes MongoDB, contradicting Postgres",
					conflictType: "violates_accepted",
					confidence: 0.9,
					changeRef: { index: 0, title: "Adopt MongoDB" },
				},
			],
		});

		await handlers.applyChanges({
			input: { ...baseInput, approvedChanges: [conflictChange] },
			context: ctx,
		});

		expect(mocks.runDecisionPrecheck).toHaveBeenCalledTimes(1);
		const precheckArg = mocks.runDecisionPrecheck.mock.calls[0]?.[0] as {
			artifact: { surface: string; items: Array<{ text: string }> };
		};
		expect(precheckArg.artifact.surface).toBe("backlog_proposal");
		expect(precheckArg.artifact.items[0]?.text).toContain("Adopt MongoDB");
		// The server-detected conflict is re-resolved against the DB + logged.
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAuditFromRequest.mock.calls[0]?.[1] as {
			resource: { id: string };
			metadata: { surface: string };
		};
		expect(audit.resource.id).toBe("dec-1");
		expect(audit.metadata.surface).toBe("backlog_proposal");
	});

	it("a forged clean 'ok' from the client cannot suppress the override — the server re-judges and logs it", async () => {
		// A malicious/stale client relays decisionConflicts:{ok} to hide the
		// override. The procedure ignores ALL client-relayed pre-check input and
		// re-judges: the server finds the real conflict and writes the WORM row.
		mocks.runDecisionPrecheck.mockResolvedValueOnce({
			checkedAt: "2020-01-01T00:00:00.000Z",
			status: "conflicts",
			findings: [
				{
					decisionId: "dec-1",
					decisionIdentifier: "ADR-012",
					decisionTitle: "Use Postgres",
					natureOfConflict: "Proposes MongoDB",
					conflictType: "violates_accepted",
					confidence: 0.9,
					changeRef: { index: 0, title: "Adopt MongoDB" },
				},
			],
		});
		await handlers.applyChanges({
			input: {
				...baseInput,
				approvedChanges: [conflictChange],
				// Ignored by the handler (not in the input schema); present to
				// document the forged-suppression attempt the server defeats.
				decisionConflicts: { status: "ok", findings: [] },
			},
			context: ctx,
		});

		expect(mocks.runDecisionPrecheck).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
	});

	it("logs no override when the server judge finds the changes clean", async () => {
		// Default mock returns a clean "ok".
		await handlers.applyChanges({
			input: { ...baseInput, approvedChanges: [conflictChange] },
			context: ctx,
		});
		expect(mocks.runDecisionPrecheck).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
