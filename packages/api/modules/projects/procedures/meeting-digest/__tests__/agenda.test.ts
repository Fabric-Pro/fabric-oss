import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- @repo/database + @repo/temporal mocks (hoisted so the factories below
// can close over them) -------------------------------------------------------
const {
	mockDb,
	mockHasProjectAccess,
	mockIsFeatureEnabled,
	mockWorkflowStart,
	mockGetTemporalClient,
} = vi.hoisted(() => {
	const workflowStart = vi.fn();
	return {
		mockDb: {
			projectMeetingAgenda: {
				findFirst: vi.fn(),
				update: vi.fn(),
				updateMany: vi.fn(),
				create: vi.fn(),
			},
			projectLinkedMeeting: {
				findFirst: vi.fn(),
			},
		},
		mockHasProjectAccess: vi.fn(),
		mockIsFeatureEnabled: vi.fn(),
		mockWorkflowStart: workflowStart,
		mockGetTemporalClient: vi.fn(async () => ({
			workflow: { start: workflowStart },
		})),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

// The handler reaches the temporal client via `await import("@repo/temporal")`
// (dynamic, to keep the client out of the API's static module graph — see the
// comment in agenda.ts). `vi.mock` intercepts the module registry regardless
// of whether the importing side is static or dynamic, so this mock applies to
// that dynamic import exactly like a static one (mirrors
// scan/__tests__/scan-procedures.test.ts, which mocks the same module for
// start-scan's dynamic import).
vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

// --- orpc/procedures chainable: `.handler(fn)` -> `{ _handler: fn }` --------
// Pattern mirrors packages/api/modules/projects/procedures/scan/__tests__/
// scan-procedures.test.ts and modules/ai-config/procedures/providers/__tests__/
// set-default-provider.test.ts: stub the chain so `.use/.route/.input/.output`
// return the same chainable object, and `.handler(fn)` hands back the raw
// handler function for direct invocation — no oRPC server, no Prisma.
//
// NOTE on the relative specifier: this file lives one directory deeper than
// agenda.ts (in `meeting-digest/__tests__/`, not `meeting-digest/`), so the
// path to `orpc/procedures` needs one more `../` than agenda.ts's own import.
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

import {
	generateAgendaProcedure,
	saveAgendaProcedure,
	utcDayRange,
} from "../agenda";

type GenerateAgendaResult = {
	started: boolean;
	reason: "started" | "would-discard-edits" | "in-progress";
};
type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<GenerateAgendaResult>;

const generateAgenda = (
	generateAgendaProcedure as unknown as { _handler: Handler }
)._handler;

type SaveAgendaResult =
	| { saved: true; version: number }
	| { saved: false; reason: "conflict"; current: unknown };
type SaveHandler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<SaveAgendaResult>;

const saveAgenda = (saveAgendaProcedure as unknown as { _handler: SaveHandler })
	._handler;

const ctx = { user: { id: "user-1" }, session: {} };

// Comfortably in the future — clear of the PAST_GRACE_MS guard.
const OCCURRENCE_START = new Date("2030-01-01T10:00:00Z");

const baseInput = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedMeetingId: "linked-1",
	occurrenceStart: OCCURRENCE_START,
};

describe("utcDayRange", () => {
	it("spans exactly the UTC day containing the instant", () => {
		const range = utcDayRange(new Date("2026-07-25T14:30:00Z"));
		expect(range.gte.toISOString()).toBe("2026-07-25T00:00:00.000Z");
		expect(range.lt.toISOString()).toBe("2026-07-26T00:00:00.000Z");
	});

	it("keeps a rescheduled meeting inside the same range", () => {
		// A 10:00 meeting moved to 14:00 must resolve to the same agenda rather
		// than silently forking into a second row.
		const range = utcDayRange(new Date("2026-07-25T10:00:00Z"));
		const moved = new Date("2026-07-25T14:00:00Z");
		expect(moved >= range.gte && moved < range.lt).toBe(true);
	});

	it("does not bleed into the next UTC day", () => {
		const range = utcDayRange(new Date("2026-07-25T23:59:59Z"));
		expect(new Date("2026-07-26T00:00:00Z") < range.lt).toBe(false);
	});
});

describe("agenda procedure wiring", () => {
	const source = readFileSync(join(__dirname, "..", "agenda.ts"), "utf8");

	it("stacks both org gates on every procedure", () => {
		expect(source).toContain(
			"requireInputOrgPermission(Permissions.PROJECT_READ)",
		);
		expect(source).toContain(
			"requireInputOrgPermission(Permissions.PROJECT_UPDATE)",
		);
		expect(source).toContain(
			"requireProjectPermission(Permissions.PROJECT_UPDATE)",
		);
	});

	it("requires PROJECT_UPDATE to generate — admins only (D4)", () => {
		const generateBlock = source.slice(
			source.indexOf("generateAgendaProcedure"),
		);
		expect(generateBlock).toContain("Permissions.PROJECT_UPDATE");
	});

	it("collapses concurrent starts on a deterministic workflow id", () => {
		expect(source).toContain("meeting-agenda:${agenda.id}");
	});

	it("refuses to silently discard user edits (D7)", () => {
		expect(source).toContain("would-discard-edits");
	});

	it("is registered in the projects router", () => {
		const router = readFileSync(
			join(__dirname, "..", "..", "..", "router.ts"),
			"utf8",
		);
		expect(router).toContain("getAgenda: getAgendaProcedure");
		expect(router).toContain("generateAgenda: generateAgendaProcedure");
	});
});

describe("generateAgendaProcedure — behavioural guards", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockHasProjectAccess.mockResolvedValue(true);
		mockDb.projectLinkedMeeting.findFirst.mockResolvedValue({
			id: "linked-1",
		});
		mockDb.projectMeetingAgenda.update.mockResolvedValue({ id: "row-1" });
		mockDb.projectMeetingAgenda.create.mockResolvedValue({ id: "row-1" });
		mockWorkflowStart.mockResolvedValue({});
	});

	describe("same-day row reuse", () => {
		it("reuses the existing same-day row: update called with its id, create NOT called", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
				id: "existing-1",
				editedAt: null,
			});
			mockDb.projectMeetingAgenda.update.mockResolvedValue({
				id: "existing-1",
			});

			const result = await generateAgenda({
				input: baseInput,
				context: ctx,
			});

			expect(mockDb.projectMeetingAgenda.create).not.toHaveBeenCalled();
			expect(mockDb.projectMeetingAgenda.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "existing-1" },
					data: expect.objectContaining({ status: "GENERATING" }),
				}),
			);
			expect(result.started).toBe(true);
		});

		it("creates a new row when no same-day row exists", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);
			mockDb.projectMeetingAgenda.create.mockResolvedValue({
				id: "new-1",
			});

			const result = await generateAgenda({
				input: baseInput,
				context: ctx,
			});

			expect(mockDb.projectMeetingAgenda.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						projectId: "project-1",
						linkedMeetingId: "linked-1",
					}),
				}),
			);
			expect(result.started).toBe(true);
		});
	});

	describe("discard-edits guard (D7)", () => {
		it("refuses to regenerate over a hand-edited agenda without force, and never starts a workflow", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
				id: "existing-1",
				editedAt: new Date("2026-01-01T00:00:00Z"),
			});

			const result = await generateAgenda({
				input: baseInput,
				context: ctx,
			});

			expect(result).toEqual({
				started: false,
				reason: "would-discard-edits",
			});
			expect(mockGetTemporalClient).not.toHaveBeenCalled();
			expect(mockWorkflowStart).not.toHaveBeenCalled();
			expect(mockDb.projectMeetingAgenda.update).not.toHaveBeenCalled();
			expect(mockDb.projectMeetingAgenda.create).not.toHaveBeenCalled();
		});

		it("proceeds and starts the workflow when force is set", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
				id: "existing-1",
				editedAt: new Date("2026-01-01T00:00:00Z"),
			});
			mockDb.projectMeetingAgenda.update.mockResolvedValue({
				id: "existing-1",
			});

			const result = await generateAgenda({
				input: { ...baseInput, force: true },
				context: ctx,
			});

			expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ started: true, reason: "started" });
		});
	});

	describe("FAILED rollback on workflow-start failure", () => {
		it("rolls the row back to FAILED and rethrows on a generic start error", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);
			mockDb.projectMeetingAgenda.create.mockResolvedValue({
				id: "new-1",
			});
			mockWorkflowStart.mockRejectedValue(new Error("temporal down"));

			await expect(
				generateAgenda({ input: baseInput, context: ctx }),
			).rejects.toThrow("temporal down");

			expect(mockDb.projectMeetingAgenda.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "new-1" },
					data: expect.objectContaining({
						status: "FAILED",
						generationError: "temporal down",
					}),
				}),
			);
		});

		it("does NOT mark the row FAILED when the workflow is already running (dedup)", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);
			mockDb.projectMeetingAgenda.create.mockResolvedValue({
				id: "new-1",
			});
			const alreadyStarted = new Error("already started");
			alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
			mockWorkflowStart.mockRejectedValue(alreadyStarted);

			const result = await generateAgenda({
				input: baseInput,
				context: ctx,
			});

			expect(result).toEqual({ started: false, reason: "in-progress" });
			expect(mockDb.projectMeetingAgenda.update).not.toHaveBeenCalled();
		});
	});

	describe("workflow start options guard a stuck GENERATING row (#1901 final review, FIX 1)", () => {
		// If a workflow never actually executes (worker not restarted, worker
		// down, unregistered type) `workflow.start` still succeeds and the row
		// is stuck GENERATING forever with no escape but a DB edit. A forced
		// regenerate must be able to displace a stuck run, and every run must
		// be bounded so it cannot stay stuck indefinitely.
		it("starts with FAIL and a 10-minute execution timeout when not forced", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);
			mockDb.projectMeetingAgenda.create.mockResolvedValue({
				id: "new-1",
			});

			await generateAgenda({ input: baseInput, context: ctx });

			expect(mockWorkflowStart).toHaveBeenCalledWith(
				"generateMeetingAgendaWorkflow",
				expect.objectContaining({
					workflowIdConflictPolicy: "FAIL",
					workflowExecutionTimeout: "10m",
				}),
			);
		});

		it("starts with TERMINATE_EXISTING when force is set, so a stuck run can be displaced", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
				id: "existing-1",
				editedAt: null,
			});
			mockDb.projectMeetingAgenda.update.mockResolvedValue({
				id: "existing-1",
			});

			await generateAgenda({
				input: { ...baseInput, force: true },
				context: ctx,
			});

			expect(mockWorkflowStart).toHaveBeenCalledWith(
				"generateMeetingAgendaWorkflow",
				expect.objectContaining({
					workflowIdConflictPolicy: "TERMINATE_EXISTING",
					workflowExecutionTimeout: "10m",
				}),
			);
		});
	});

	describe("concurrent create race (#1901 final review, FIX 5)", () => {
		it("recovers from a P2002 on create by re-reading and reusing the winner's row instead of throwing", async () => {
			// Two interleaved requests both see no same-day row (findFirst
			// resolves null for both) and both try to create — the loser hits the
			// @@unique([linkedMeetingId, occurrenceStart]) constraint.
			mockDb.projectMeetingAgenda.findFirst
				.mockResolvedValueOnce(null) // same-day-reuse check sees nothing
				.mockResolvedValueOnce({ id: "winner-1" }); // re-read after P2002
			mockDb.projectMeetingAgenda.create.mockRejectedValue(
				Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				}),
			);
			mockDb.projectMeetingAgenda.update.mockResolvedValue({
				id: "winner-1",
			});

			const result = await generateAgenda({
				input: baseInput,
				context: ctx,
			});

			expect(mockDb.projectMeetingAgenda.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "winner-1" },
					data: expect.objectContaining({ status: "GENERATING" }),
				}),
			);
			expect(result).toEqual({ started: true, reason: "started" });
		});

		it("rethrows a create error that is not P2002", async () => {
			mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);
			mockDb.projectMeetingAgenda.create.mockRejectedValue(
				new Error("connection reset"),
			);

			await expect(
				generateAgenda({ input: baseInput, context: ctx }),
			).rejects.toThrow("connection reset");
			expect(mockGetTemporalClient).not.toHaveBeenCalled();
		});

		it("rethrows the original P2002 if the winner's row cannot be found on re-read", async () => {
			mockDb.projectMeetingAgenda.findFirst
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null); // re-read also finds nothing
			mockDb.projectMeetingAgenda.create.mockRejectedValue(
				Object.assign(new Error("Unique constraint failed"), {
					code: "P2002",
				}),
			);

			await expect(
				generateAgenda({ input: baseInput, context: ctx }),
			).rejects.toThrow("Unique constraint failed");
		});
	});
});

describe("saveAgenda", () => {
	const source = readFileSync(join(__dirname, "..", "agenda.ts"), "utf8");

	it("returns a conflict instead of throwing", () => {
		// auditErrorMiddleware snapshots procedure INPUT into an org-admin-readable
		// AuditLog row on ANY throw, and redaction is key-name-substring only —
		// `content` is not on the denylist. Throwing on a routine concurrent edit
		// would publish the user's agenda text to the audit log every time.
		const saveBlock = source.slice(source.indexOf("saveAgendaProcedure"));
		expect(saveBlock).toContain('reason: "conflict"');
		expect(saveBlock).not.toMatch(
			/expectedVersion[\s\S]{0,400}throw new ORPCError\("CONFLICT"/,
		);
	});

	it("requires PROJECT_UPDATE — admins only (D4)", () => {
		const saveBlock = source.slice(source.indexOf("saveAgendaProcedure"));
		expect(saveBlock).toContain("Permissions.PROJECT_UPDATE");
	});

	it("is on the audit-error skip list", () => {
		const middleware = readFileSync(
			join(
				__dirname,
				"..",
				"..",
				"..",
				"..",
				"..",
				"orpc",
				"middleware",
				"audit-error-middleware.ts",
			),
			"utf8",
		);
		expect(middleware).toContain("projects.meetingDigest.saveAgenda");
	});

	it("is registered in the projects router", () => {
		const router = readFileSync(
			join(__dirname, "..", "..", "..", "router.ts"),
			"utf8",
		);
		expect(router).toContain("saveAgenda: saveAgendaProcedure");
	});
});

describe("saveAgendaProcedure — behavioural guards", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockHasProjectAccess.mockResolvedValue(true);
	});

	const baseSaveInput = {
		projectId: "project-1",
		organizationId: "org-1",
		agendaId: "agenda-1",
		content: "new content",
		expectedVersion: 3,
	};

	it("saves when expectedVersion matches: bumps version, sets editedAt/editedById", async () => {
		mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
			id: "agenda-1",
			version: 3,
		});
		mockDb.projectMeetingAgenda.updateMany.mockResolvedValue({ count: 1 });

		const result = await saveAgenda({ input: baseSaveInput, context: ctx });

		expect(mockDb.projectMeetingAgenda.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "agenda-1",
					projectId: "project-1",
					version: 3,
				}),
				data: expect.objectContaining({
					content: "new content",
					editedById: "user-1",
					version: { increment: 1 },
				}),
			}),
		);
		expect(result).toEqual({ saved: true, version: 4 });
	});

	it("returns a conflict without throwing when expectedVersion is stale, and does not write", async () => {
		mockDb.projectMeetingAgenda.findFirst.mockResolvedValue({
			id: "agenda-1",
			version: 5,
		});

		const result = await saveAgenda({
			input: { ...baseSaveInput, expectedVersion: 3 },
			context: ctx,
		});

		expect(result).toEqual({
			saved: false,
			reason: "conflict",
			current: { id: "agenda-1", version: 5 },
		});
		expect(mockDb.projectMeetingAgenda.updateMany).not.toHaveBeenCalled();
	});

	it("treats updateMany count 0 (a lost race) as a conflict, not success", async () => {
		mockDb.projectMeetingAgenda.findFirst
			.mockResolvedValueOnce({ id: "agenda-1", version: 3 }) // pre-check
			.mockResolvedValueOnce({ id: "agenda-1", version: 4 }); // re-fetch after the lost race
		mockDb.projectMeetingAgenda.updateMany.mockResolvedValue({ count: 0 });

		const result = await saveAgenda({ input: baseSaveInput, context: ctx });

		expect(result).toEqual({
			saved: false,
			reason: "conflict",
			current: { id: "agenda-1", version: 4 },
		});
	});

	it("throws NOT_FOUND when the agenda id does not exist", async () => {
		mockDb.projectMeetingAgenda.findFirst.mockResolvedValue(null);

		await expect(
			saveAgenda({ input: baseSaveInput, context: ctx }),
		).rejects.toThrow();
		expect(mockDb.projectMeetingAgenda.updateMany).not.toHaveBeenCalled();
	});
});
