import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, (args: any) => Promise<any>>,
	rows: new Map<string, any>(),
	sessions: new Map<string, any>(),
	createSession: vi.fn(),
	sessionUpdateMany: vi.fn(),
	start: vi.fn(),
	terminate: vi.fn(),
	client: vi.fn(),
	updateMany: vi.fn(),
	findUnique: vi.fn(),
	dedup: vi.fn(),
	finalizeSession: vi.fn(),
}));

// Only the Prisma boundary is replaced: finalization and cancellation use the
// real query helpers against the state left by the procedure's writes.
vi.mock("../../../../../../database/prisma/client", () => ({
	db: {
		pendingBacklogProposalApplication: { findMany: async () => [] },
		pendingBacklogProposal: {
			findUnique: async ({ where }: any) => h.rows.get(where.id) ?? null,
			update: async ({ where, data }: any) =>
				Object.assign(h.rows.get(where.id), data),
			updateMany: (...args: any[]) => h.updateMany(...args),
		},
	},
}));
vi.mock("@repo/database", async () => {
	const queries = await import(
		"../../../../../../database/prisma/queries/projects/pending-backlog-proposals"
	);
	const create = async (data: any) => {
		const row = {
			status: "PENDING",
			applyWorkflowId: null,
			applyStartedAt: null,
			reviewedAt: null,
			createdAt: new Date(),
			appliedChangeIndexes: [],
			...data,
			id: data.id ?? `example-proposal-${h.rows.size}`,
		};
		h.rows.set(row.id, row);
		return row;
	};
	return {
		...queries,
		db: {
			$transaction: async (run: any) =>
				run({
					$queryRaw: async () => [],
					backlogUpdateSession: { findFirst: async () => null },
				}),
			backlogUpdateSession: {
				updateMany: (...args: any[]) => h.sessionUpdateMany(...args),
			},
			project: {
				findUnique: async () => ({ organizationId: "example-org" }),
				findFirst: async () => ({ organizationId: "example-org" }),
			},
			pendingBacklogProposal: {
				findUnique: (...args: any[]) => h.findUnique(...args),
				upsert: async ({ where, create: data }: any) =>
					h.rows.get(where.id) ?? create(data),
				updateMany: (...args: any[]) => h.updateMany(...args),
				update: async ({ where, data }: any) =>
					Object.assign(h.rows.get(where.id), data),
			},
		},
		createPendingBacklogProposal: create,
		getPendingBacklogProposal: async (id: string) =>
			h.rows.has(id) ? { ...h.rows.get(id) } : null,
		listFailedProposals: async () =>
			[...h.rows.values()].map((row) => ({ ...row })),
		buildBacklogDedupGuard: () => h.dedup(),
		inferDedupFamily: () => "FEATURE",
		getBoundPromptForAgent: vi.fn(),
		createBacklogUpdateSession: (...args: any[]) =>
			h.createSession(...args),
		finalizeBacklogUpdateSession: (...args: any[]) =>
			h.finalizeSession(...args),
		recordAudit: vi.fn(),
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => h.client(),
	runDecisionPrecheck: async () => ({ status: "ok", findings: [] }),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (v: any) => v,
}));
vi.mock("../../../../../orpc/procedures", () => {
	let path = "";
	const builder: any = {
		use: () => builder,
		route: (options: any) => {
			path = options.path;
			return builder;
		},
		input: () => builder,
		output: () => builder,
		handler: (fn: any) => {
			h.handlers[path] = fn;
			return builder;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (v: any) => v,
		resolveOrganizationId: () => "example-org",
	};
});
await import("../apply-changes");
await import("../retry-failed-proposal");
await import("../retry-all-failed-proposals");
await import("../cancel-pending-proposal");
const {
	finalizeClaimedProposal,
	claimPendingProposalForApply,
	markPendingProposalRejected,
	markPendingProposalBacklog,
	timeOutStaleApply,
	stopApplyingProposal,
} = await import(
	"../../../../../../database/prisma/queries/projects/pending-backlog-proposals"
);

const change = {
	type: "feature",
	action: "create",
	title: { to: "Example feature" },
	reasoning: "Requested",
	sourceContext: "teams_messages",
};
const context = { user: { id: "example-user" }, session: {} };
const call = (action: string, extra = {}) =>
	h.handlers[`/projects/{projectId}/backlog/${action}`]({
		input: {
			projectId: "example-project",
			proposalId: "example-proposal",
			organizationId: "example-org",
			...extra,
		},
		context,
	});
function matches(row: any, where: any): boolean {
	return Object.entries(where).every(([key, value]: any) => {
		if (key === "OR") {
			return value.some((w: any) => matches(row, w));
		}
		if (key === "AND") {
			return value.every((w: any) => matches(row, w));
		}
		if (value && typeof value === "object" && !(value instanceof Date)) {
			return (
				(!value.in || value.in.includes(row[key])) &&
				(!("not" in value) || (row[key] ?? null) !== value.not) &&
				(!value.lt || (row[key] instanceof Date && row[key] < value.lt))
			);
		}
		return row[key] === value;
	});
}
function seed(status = "FAILED", extra = {}) {
	const row = {
		id: "example-proposal",
		projectId: "example-project",
		organizationId: "example-org",
		userId: "example-user",
		source: "AI_UPDATE_SIDEBAR",
		status,
		proposal: { changes: [change] },
		sourceMetadata: {},
		appliedChangeIndexes: [],
		applyWorkflowId: "example-old-workflow",
		applyStartedAt: null,
		reviewedAt: null,
		...extra,
	};
	h.rows.set(row.id, row);
	return row;
}
beforeEach(() => {
	vi.resetAllMocks();
	h.rows.clear();
	h.sessions.clear();
	h.createSession.mockImplementation(async (data: any) => {
		const row = {
			...data,
			id: `example-session-${h.sessions.size}`,
			status: "APPLYING",
		};
		h.sessions.set(row.id, row);
		return row;
	});
	h.sessionUpdateMany.mockImplementation(async ({ where, data }: any) => {
		let count = 0;
		for (const row of h.sessions.values()) {
			if (matches(row, where)) {
				Object.assign(row, data);
				count++;
			}
		}
		return { count };
	});
	h.findUnique.mockImplementation(
		async ({ where }: any) => h.rows.get(where.id) ?? null,
	);
	h.finalizeSession.mockResolvedValue(undefined);
	h.dedup.mockResolvedValue({ findCollision: () => null });
	h.updateMany.mockImplementation(async ({ where, data }: any) => {
		let count = 0;
		for (const row of h.rows.values()) {
			if (matches(row, where)) {
				Object.assign(row, data);
				count++;
			}
		}
		return { count };
	});
	h.start.mockImplementation(async (_type: string, options: any) => ({
		workflowId: options.workflowId,
		firstExecutionRunId: "example-run",
	}));
	h.client.mockResolvedValue({
		workflow: {
			start: h.start,
			getHandle: () => ({
				describe: async () => {
					throw Object.assign(new Error("missing"), {
						name: "WorkflowNotFoundError",
					});
				},
				terminate: h.terminate,
			}),
		},
	});
});

describe("apply row ownership", () => {
	it.each([undefined, "example-operation"])(
		"claims fresh apply before start and permits immediate APPLIED (%s)",
		async (operationKey) => {
			h.start.mockImplementationOnce(
				async (_type: string, options: any) => {
					const id = options.args[0].pendingProposalId;
					expect(h.rows.get(id)).toMatchObject({
						status: "APPLYING",
						applyWorkflowId: options.workflowId,
						applyStartedAt: null,
					});
					expect(
						await finalizeClaimedProposal({
							proposalId: id,
							applyWorkflowId: options.workflowId,
							outcome: "applied",
						}),
					).toBe(true);
					return {
						workflowId: options.workflowId,
						firstExecutionRunId: "example-run",
					};
				},
			);
			const result = await call("apply", {
				proposalId: undefined,
				approvedChanges: [change],
				syncToPM: false,
				operationKey,
			});
			expect(h.rows.get(result.proposalId).status).toBe("APPLIED");
		},
	);
	it("retries a keyed claim after start fails without a dispatch stamp", async () => {
		h.start.mockRejectedValueOnce(new Error("start unavailable"));
		await expect(
			call("apply", {
				proposalId: undefined,
				approvedChanges: [change],
				operationKey: "example-operation",
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		const row = [...h.rows.values()][0];
		expect(row).toMatchObject({
			status: "APPLYING",
			applyWorkflowId: expect.any(String),
			applyStartedAt: null,
		});
		const result = await call("apply", {
			proposalId: undefined,
			approvedChanges: [change],
			operationKey: "example-operation",
		});
		expect(h.start).toHaveBeenCalledTimes(2);
		expect(row).toMatchObject({
			status: "APPLYING",
			applyWorkflowId: result.workflowId,
			applyStartedAt: expect.any(Date),
		});
	});
	it.each(["proposals/{proposalId}/retry", "proposals/retry-all-failed"])(
		"claims retry before start and finalizes: %s",
		async (action) => {
			const row = seed();
			h.start.mockImplementationOnce(
				async (_type: string, options: any) => {
					expect(row).toMatchObject({
						status: "APPLYING",
						applyWorkflowId: options.workflowId,
						applyStartedAt: null,
						reviewedAt: expect.any(Date),
						reviewedBy: "example-user",
					});
					expect(
						await finalizeClaimedProposal({
							proposalId: row.id,
							applyWorkflowId: options.workflowId,
							outcome: "applied",
						}),
					).toBe(true);
					return {
						workflowId: options.workflowId,
						firstExecutionRunId: "example-run",
					};
				},
			);
			await call(action);
			expect(row.status).toBe("APPLIED");
		},
	);
	it.each(["proposals/{proposalId}/retry", "proposals/retry-all-failed"])(
		"only dispatches one concurrent retry: %s",
		async (action) => {
			const row = seed();
			await Promise.allSettled([call(action), call(action)]);
			expect(h.start).toHaveBeenCalledTimes(1);
			expect(row.status).toBe("APPLYING");
		},
	);
	it.each(["proposals/{proposalId}/retry", "proposals/retry-all-failed"])(
		"does not let dedup-only retry overwrite a live claim: %s",
		async (action) => {
			const row = seed();
			h.dedup.mockImplementationOnce(async () => {
				row.status = "APPLYING";
				row.applyWorkflowId = "example-competing-workflow";
				return {
					findCollision: () => ({ existingId: "example-story" }),
				};
			});
			await call(action).catch(() => {});
			expect(row).toMatchObject({
				status: "APPLYING",
				applyWorkflowId: "example-competing-workflow",
			});
			expect(h.start).not.toHaveBeenCalled();
		},
	);
	it.each(["proposals/{proposalId}/retry", "proposals/retry-all-failed"])(
		"restores FAILED after start rejection: %s",
		async (action) => {
			const row = seed();
			h.start.mockRejectedValueOnce(new Error("start unavailable"));
			await call(action).catch(() => {});
			expect(row).toMatchObject({
				status: "FAILED",
				errorClass: "TemporalScheduleFailed",
			});
		},
	);
	it.each(["proposals/{proposalId}/retry", "proposals/retry-all-failed"])(
		"preserves a finished row when the start response fails: %s",
		async (action) => {
			const row = seed();
			h.start.mockImplementationOnce(
				async (_type: string, options: any) => {
					await finalizeClaimedProposal({
						proposalId: row.id,
						applyWorkflowId: options.workflowId,
						outcome: "applied",
					});
					throw new Error("response lost");
				},
			);
			await call(action).catch(() => {});
			expect(row.status).toBe("APPLIED");
		},
	);
	it("cancels APPLYING with a confirmed dispatch", async () => {
		const row = seed("APPLYING", { applyStartedAt: new Date() });
		expect(await call("proposals/{proposalId}/cancel")).toMatchObject({
			cancelled: true,
		});
		expect(row).toMatchObject({
			status: "FAILED",
			errorClass: "Cancelled",
		});
		expect(h.terminate).toHaveBeenCalledWith("cancelled_by_user");
		expect(
			await finalizeClaimedProposal({
				proposalId: row.id,
				applyWorkflowId: row.applyWorkflowId,
				outcome: "applied",
			}),
		).toBe(false);
	});
	it("keeps cancellation compatible with old PENDING-dispatched rows", async () => {
		const row = seed("PENDING", { applyStartedAt: new Date() });
		expect(await call("proposals/{proposalId}/cancel")).toMatchObject({
			cancelled: true,
		});
		expect(row.status).toBe("FAILED");
	});
	it("refuses cancellation for an awaiting-review row", async () => {
		seed("PENDING", { applyWorkflowId: null });
		await expect(
			call("proposals/{proposalId}/cancel"),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("fences cancel against a replacement workflow", async () => {
		const row = seed("PENDING", { applyStartedAt: new Date() });
		h.terminate.mockImplementationOnce(async () => {
			row.applyWorkflowId = "example-replacement";
			row.status = "APPLYING";
		});
		expect(await call("proposals/{proposalId}/cancel")).toMatchObject({
			cancelled: false,
		});
		expect(row.status).toBe("APPLYING");
	});
	it("refuses Apply, Reject and Move-to-Backlog during a fresh dispatch", async () => {
		h.start.mockImplementationOnce(async (_type: string, options: any) => {
			const id = options.args[0].pendingProposalId;
			expect(
				await claimPendingProposalForApply({
					proposalId: id,
					reviewedBy: "example-other-user",
					applyWorkflowId: "example-other-workflow",
				}),
			).toBe(false);
			expect(
				await markPendingProposalRejected({
					proposalId: id,
					reviewedBy: "example-other-user",
				}),
			).toEqual({ updated: false });
			expect(
				await markPendingProposalBacklog({
					proposalId: id,
					reviewedBy: "example-other-user",
				}),
			).toEqual({ updated: false });
			expect(h.rows.get(id)).toMatchObject({
				status: "APPLYING",
				applyWorkflowId: options.workflowId,
			});
			return { workflowId: options.workflowId };
		});
		await call("apply", {
			proposalId: undefined,
			approvedChanges: [change],
		});
	});
});

describe("watchdog claim clock", () => {
	it("refreshes an old keyed claim before the watchdog can time out its new dispatch", async () => {
		vi.useFakeTimers();
		try {
			const old = new Date("2026-10-21T11:00:00Z");
			const now = new Date("2026-10-21T11:20:00Z");
			vi.setSystemTime(old);
			const input = {
				proposalId: undefined,
				approvedChanges: [change],
				operationKey: "example-operation",
			};
			h.start.mockRejectedValueOnce(new Error("start unavailable"));
			await expect(call("apply", input)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
			});
			const row = [...h.rows.values()][0];
			expect(row.createdAt).toEqual(old);
			vi.setSystemTime(now);
			let timedOut = -1;
			h.start.mockImplementationOnce(
				async (_type: string, options: any) => {
					timedOut = await timeOutStaleApply({
						proposalId: row.id,
						cutoff: new Date(now.getTime() - 15 * 60_000),
						errorClass: "TimedOut",
						errorMessage: "Example timeout",
					});
					await finalizeClaimedProposal({
						proposalId: row.id,
						applyWorkflowId: options.workflowId,
						outcome: "applied",
					});
					return {
						workflowId: options.workflowId,
						firstExecutionRunId: "example-run",
					};
				},
			);
			await call("apply", input);
			expect.soft(timedOut).toBe(0);
			expect.soft(row).toMatchObject({
				reviewedAt: now,
				reviewedBy: "example-user",
				status: "APPLIED",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("confirmed dispatch cancellation", () => {
	it("refuses an APPLYING claim still starting without terminating or failing it", async () => {
		const row = seed("APPLYING", { applyStartedAt: null });
		await expect(
			call("proposals/{proposalId}/cancel"),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("still starting"),
		});
		expect(row.status).toBe("APPLYING");
		expect(h.terminate).not.toHaveBeenCalled();
		expect(h.finalizeSession).not.toHaveBeenCalled();
		expect(h.updateMany).not.toHaveBeenCalled();
	});
	it.each(["APPLYING", "PENDING"])(
		"refuses an unstamped %s row at the database write boundary",
		async (status) => {
			const row = seed(status, { applyStartedAt: null });
			expect(
				await stopApplyingProposal({
					proposalId: row.id,
					applyWorkflowId: row.applyWorkflowId,
					errorClass: "Cancelled",
					errorMessage: "Example cancellation",
				}),
			).toBe(0);
			expect(row.status).toBe(status);
		},
	);
	it("rechecks confirmed dispatch if its stamp is cleared before the cancel write", async () => {
		const row = seed("APPLYING", { applyStartedAt: new Date() });
		h.terminate.mockImplementationOnce(async () => {
			row.applyStartedAt = null;
		});
		expect(await call("proposals/{proposalId}/cancel")).toMatchObject({
			cancelled: false,
		});
		expect(row.status).toBe("APPLYING");
		expect(h.finalizeSession).not.toHaveBeenCalled();
	});
});

describe("claim conflict", () => {
	it.each([undefined, "example-operation"])(
		"returns CONFLICT without failure side effects for a lost claim (%s)",
		async (operationKey) => {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				h.updateMany.mockImplementationOnce(async () => {
					const row = [...h.rows.values()][0];
					Object.assign(row, {
						status: "APPLYING",
						applyWorkflowId: "example-other-workflow",
						reviewedBy: "example-other-user",
					});
					return { count: 0 };
				});
				const result = await call("apply", {
					proposalId: undefined,
					approvedChanges: [change],
					operationKey,
				}).catch((error) => error);
				expect.soft(result).toMatchObject({ code: "CONFLICT" });
				expect.soft(h.start).not.toHaveBeenCalled();
				expect.soft(h.finalizeSession).not.toHaveBeenCalled();
				expect
					.soft(
						h.updateMany.mock.calls.filter(
							([args]) => args.data.status === "FAILED",
						),
					)
					.toHaveLength(0);
				expect.soft(log).not.toHaveBeenCalled();
				expect.soft([...h.rows.values()][0]).toMatchObject({
					status: "APPLYING",
					applyWorkflowId: "example-other-workflow",
				});
			} finally {
				log.mockRestore();
			}
		},
	);
});

describe("current claim dispatch confirmation", () => {
	it.each([
		"apply",
		"proposals/{proposalId}/retry",
		"proposals/retry-all-failed",
	])(
		"refuses cancellation until start returns and then permits it: %s",
		async (action) => {
			const row = seed("FAILED", {
				applyStartedAt: new Date("2026-10-21T10:00:00Z"),
				reviewedAt: new Date("2026-10-21T10:00:00Z"),
			});
			h.start.mockImplementationOnce(
				async (_type: string, options: any) => {
					expect.soft(row).toMatchObject({
						status: "APPLYING",
						applyWorkflowId: options.workflowId,
						applyStartedAt: null,
						reviewedAt: expect.any(Date),
					});
					await expect
						.soft(call("proposals/{proposalId}/cancel"))
						.rejects.toMatchObject({
							code: "CONFLICT",
							message: expect.stringContaining("still starting"),
						});
					expect
						.soft(
							await stopApplyingProposal({
								proposalId: row.id,
								applyWorkflowId: options.workflowId,
								errorClass: "Cancelled",
								errorMessage: "Example cancellation",
							}),
						)
						.toBe(0);
					return {
						workflowId: options.workflowId,
						firstExecutionRunId: "example-run",
					};
				},
			);
			await call(action, { approvedChanges: [change] });
			expect(row).toMatchObject({
				status: "APPLYING",
				applyStartedAt: expect.any(Date),
			});
			expect(h.terminate).not.toHaveBeenCalled();
			expect(await call("proposals/{proposalId}/cancel")).toMatchObject({
				cancelled: true,
			});
			expect(row).toMatchObject({
				status: "FAILED",
				errorClass: "Cancelled",
			});
		},
	);
	it("keeps a newly claimed unstamped row fresh until its review clock ages", async () => {
		vi.useFakeTimers();
		try {
			const now = new Date("2026-10-21T12:20:00Z");
			vi.setSystemTime(now);
			const row = seed("FAILED", {
				createdAt: new Date("2026-10-21T10:00:00Z"),
				applyStartedAt: new Date("2026-10-21T10:00:00Z"),
			});
			await claimPendingProposalForApply({
				proposalId: row.id,
				reviewedBy: "example-user",
				applyWorkflowId: "example-new-workflow",
			});
			expect
				.soft(row)
				.toMatchObject({ applyStartedAt: null, reviewedAt: now });
			const timeout = () =>
				timeOutStaleApply({
					proposalId: row.id,
					cutoff: new Date(Date.now() - 15 * 60_000),
					errorClass: "TimedOut",
					errorMessage: "Example timeout",
				});
			expect(await timeout()).toBe(0);
			vi.advanceTimersByTime(16 * 60_000);
			expect(await timeout()).toBe(1);
			expect(row.status).toBe("FAILED");
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not redispatch a keyed claim confirmed after reconciliation", async () => {
		h.start.mockRejectedValueOnce(new Error("start unavailable"));
		const input = {
			proposalId: undefined,
			approvedChanges: [change],
			operationKey: "example-operation",
		};
		await call("apply", input).catch(() => {});
		const row = [...h.rows.values()][0];
		const update = h.updateMany.getMockImplementation();
		if (!update) {
			throw new Error("Missing row fixture");
		}
		const confirmed = new Date("2026-10-21T12:20:00Z");
		h.updateMany.mockImplementationOnce(async (args: any) => {
			row.applyStartedAt = confirmed;
			return update(args);
		});
		await expect(call("apply", input)).resolves.toMatchObject({
			proposalId: row.id,
			message:
				"Backlog apply already dispatched; open Review proposals for its outcome.",
		});
		expect(row.applyStartedAt).toBe(confirmed);
		expect(h.start).toHaveBeenCalledTimes(1);
	});
	it("keeps CONFLICT when a keyed claim loses to a timeout before any dispatch", async () => {
		h.start.mockRejectedValueOnce(new Error("start unavailable"));
		const input = {
			proposalId: undefined,
			approvedChanges: [change],
			operationKey: "example-operation",
		};
		await call("apply", input).catch(() => {});
		const row = [...h.rows.values()][0];
		const update = h.updateMany.getMockImplementation();
		if (!update) {
			throw new Error("Missing row fixture");
		}
		h.updateMany.mockImplementationOnce(async (args: any) => {
			row.status = "FAILED";
			return update(args);
		});
		await expect(call("apply", input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(row.applyStartedAt).toBeNull();
		expect(h.start).toHaveBeenCalledTimes(1);
	});
	it("keeps CONFLICT when a new keyed row is rejected before its claim", async () => {
		const input = {
			proposalId: undefined,
			approvedChanges: [change],
			operationKey: "example-operation",
		};
		const update = h.updateMany.getMockImplementation();
		if (!update) {
			throw new Error("Missing row fixture");
		}
		h.updateMany.mockImplementationOnce(async (args: any) => {
			const row = [...h.rows.values()][0];
			row.status = "REJECTED";
			return update(args);
		});
		await expect(call("apply", input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(h.start).not.toHaveBeenCalled();
	});
});

describe("keyed dispatch evidence", () => {
	const input = {
		proposalId: undefined,
		approvedChanges: [change],
		operationKey: "example-operation",
	};
	it.each(["REJECTED", "FAILED"])(
		"refuses success when the claim-miss read fails on an unstamped %s row",
		async (status) => {
			const update = h.updateMany.getMockImplementation();
			if (!update) {
				throw new Error("Missing row fixture");
			}
			h.updateMany.mockImplementationOnce(async (args: any) => {
				const row = [...h.rows.values()][0];
				row.status = status;
				if (status === "FAILED") {
					row.applyWorkflowId = args.data.applyWorkflowId;
					row.errorClass = "TimedOut";
				}
				h.findUnique.mockRejectedValueOnce(
					new Error("Reconcile read unavailable"),
				);
				return update(args);
			});
			await expect(call("apply", input)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				message:
					"Could not confirm apply dispatch. Retry apply with the same approval.",
			});
			expect(h.start).not.toHaveBeenCalled();
			expect([...h.rows.values()][0].applyStartedAt).toBeNull();
		},
	);
	it.each([
		{
			status: "REJECTED",
			stamped: false,
			sameWorkflow: false,
			dispatched: false,
		},
		{
			status: "FAILED",
			stamped: false,
			sameWorkflow: true,
			dispatched: false,
		},
		{
			status: "APPLIED",
			stamped: false,
			sameWorkflow: true,
			dispatched: true,
		},
		{
			status: "FAILED",
			stamped: true,
			sameWorkflow: true,
			dispatched: true,
		},
		{
			status: "APPLIED",
			stamped: false,
			sameWorkflow: false,
			dispatched: false,
		},
		{
			status: "FAILED",
			stamped: true,
			sameWorkflow: false,
			dispatched: false,
		},
	])(
		"checks request-entry dispatch evidence: %j",
		async ({ status, stamped, sameWorkflow, dispatched }) => {
			h.start.mockRejectedValueOnce(new Error("Start unavailable"));
			await expect(call("apply", input)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
			});
			const row = [...h.rows.values()][0];
			Object.assign(row, {
				status,
				applyStartedAt: stamped
					? new Date("2026-10-21T12:20:00Z")
					: null,
				applyWorkflowId: sameWorkflow ? row.applyWorkflowId : null,
			});
			h.start.mockClear();
			h.updateMany.mockClear();
			if (dispatched) {
				await expect(call("apply", input)).resolves.toMatchObject({
					proposalId: row.id,
					workflowId: row.applyWorkflowId,
					message:
						"Backlog apply already dispatched; open Review proposals for its outcome.",
				});
				expect(h.updateMany).not.toHaveBeenCalled();
			} else {
				await expect(call("apply", input)).rejects.toMatchObject({
					code: "CONFLICT",
				});
			}
			expect(h.start).not.toHaveBeenCalled();
		},
	);
});

describe("lost fresh claim session cleanup", () => {
	it.each([undefined, "example-operation"])(
		"fails only this call's APPLYING session (%s)",
		async (operationKey) => {
			const other = { id: "example-other-session", status: "APPLYING" };
			h.sessions.set(other.id, other);
			h.updateMany.mockResolvedValueOnce({ count: 0 });
			await expect(
				call("apply", {
					proposalId: undefined,
					approvedChanges: [change],
					operationKey,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(h.sessions.get("example-session-1")).toMatchObject({
				status: "FAILED",
				finalizedAt: expect.any(Date),
			});
			expect(other.status).toBe("APPLYING");
			expect(h.sessionUpdateMany).toHaveBeenCalledWith({
				where: { id: "example-session-1", status: "APPLYING" },
				data: expect.objectContaining({ status: "FAILED" }),
			});
			expect(h.finalizeSession).not.toHaveBeenCalled();
		},
	);
});
