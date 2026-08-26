import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		applyPriorityChanges: vi.fn(),
		userStoryFindFirst: vi.fn(),
		userStoryFindUnique: vi.fn(),
		recordAudit: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	applyPriorityChanges: mocks.applyPriorityChanges,
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			findUnique: mocks.userStoryFindUnique,
		},
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["setStoryPriority"];
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
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../set-story-priority");

const ctx = {
	user: { id: "u-1", name: "A. Diaz" },
	session: {},
};

const CHANGED_AT = new Date("2026-07-21T09:00:00Z");

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "p-1",
		organizationId: null,
		storyId: "s-1",
		priority: "P0_CRITICAL",
		...overrides,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.userStoryFindFirst.mockResolvedValue({
		id: "s-1",
		identifier: "F-12",
		title: "Rate limit the export endpoint",
	});
	mocks.applyPriorityChanges.mockResolvedValue([
		{
			storyId: "s-1",
			fromPriority: "P2_MEDIUM",
			toPriority: "P0_CRITICAL",
		},
	]);
	mocks.userStoryFindUnique.mockResolvedValue({
		priorityChangedAt: CHANGED_AT,
	});
});

describe("set-story-priority — happy path", () => {
	it("applies the band as a MANUAL change by the calling user and returns it", async () => {
		const result = await handlers.setStoryPriority({
			input: input({ comment: "Blocking the launch" }),
			context: ctx,
		});

		const [projectId, requests, source, actor] =
			mocks.applyPriorityChanges.mock.calls[0];
		expect(projectId).toBe("p-1");
		expect(source).toBe("MANUAL");
		// The actor is snapshotted from the session, never from the input —
		// a caller can't attribute a move to somebody else.
		expect(actor).toEqual({ id: "u-1", name: "A. Diaz" });
		expect(requests).toEqual([
			{
				storyId: "s-1",
				toPriority: "P0_CRITICAL",
				reason: "Blocking the launch",
			},
		]);
		expect(result).toEqual({
			changed: true,
			priority: "P0_CRITICAL",
			priorityChangedAt: CHANGED_AT,
		});
	});

	it("reports the band the DB layer actually landed on, not the requested one", async () => {
		mocks.applyPriorityChanges.mockResolvedValue([
			{ storyId: "s-1", fromPriority: "P3_LOW", toPriority: "P1_HIGH" },
		]);

		const result = await handlers.setStoryPriority({
			input: input({ priority: "P1_HIGH" }),
			context: ctx,
		});

		expect(result.priority).toBe("P1_HIGH");
	});

	it("passes a null actor name when the account has none", async () => {
		await handlers.setStoryPriority({
			input: input(),
			context: { user: { id: "u-1", name: null }, session: {} },
		});

		const [, , , actor] = mocks.applyPriorityChanges.mock.calls[0];
		expect(actor).toEqual({ id: "u-1", name: null });
	});
});

describe("set-story-priority — the optional comment", () => {
	it("sends no reason when the comment is omitted", async () => {
		await handlers.setStoryPriority({ input: input(), context: ctx });

		const [, requests] = mocks.applyPriorityChanges.mock.calls[0];
		expect(requests[0].reason).toBeUndefined();
	});

	it("does not treat a whitespace-only comment as a comment", async () => {
		await handlers.setStoryPriority({
			input: input({ comment: "   " }),
			context: ctx,
		});

		// The blank is normalised to a null `reason` one layer down, in
		// `recordPriorityMove` (`reason?.trim() || null`) — the single place
		// every priority write funnels through. What the procedure owns is the
		// audit signal, which must not claim a comment was left.
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				metadata: expect.objectContaining({ hasComment: false }),
			}),
		);
	});

	it("flags a real comment in the audit metadata", async () => {
		await handlers.setStoryPriority({
			input: input({ comment: "Customer escalation" }),
			context: ctx,
		});

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				metadata: expect.objectContaining({ hasComment: true }),
			}),
		);
	});
});

describe("set-story-priority — the no-op", () => {
	it("returns changed:false and writes no audit row when the band did not move", async () => {
		mocks.applyPriorityChanges.mockResolvedValue([]);

		const result = await handlers.setStoryPriority({
			input: input({ comment: "Still critical" }),
			context: ctx,
		});

		expect(result).toEqual({
			changed: false,
			priority: "P0_CRITICAL",
			priorityChangedAt: null,
		});
		// A no-op leaves no trace anywhere: not in the history (the DB layer's
		// job) and not in the audit log (this procedure's job).
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("does not re-read the story for a stamp it knows is unchanged", async () => {
		mocks.applyPriorityChanges.mockResolvedValue([]);

		await handlers.setStoryPriority({ input: input(), context: ctx });

		expect(mocks.userStoryFindUnique).not.toHaveBeenCalled();
	});
});

describe("set-story-priority — audit", () => {
	it("records story.updated with via=priority-manual and the from/to bands", async () => {
		await handlers.setStoryPriority({
			input: input({ comment: "Blocking the launch" }),
			context: ctx,
		});

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.updated",
				category: "story",
				projectId: "p-1",
				resource: expect.objectContaining({
					type: "story",
					id: "s-1",
				}),
				metadata: expect.objectContaining({
					via: "priority-manual",
					changedFields: ["priority"],
					identifier: "F-12",
					from: "P2_MEDIUM",
					to: "P0_CRITICAL",
				}),
			}),
		);
	});
});

describe("set-story-priority — tenancy", () => {
	it("throws NOT_FOUND and writes nothing for a story outside the project", async () => {
		// requireProjectPermission has already cleared the project, so this
		// lookup is the only thing standing between a borrowed story id from
		// another tenant and a write.
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.setStoryPriority({
				input: input({ storyId: "s-from-another-tenant" }),
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);

		expect(mocks.applyPriorityChanges).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("scopes the story lookup by projectId", async () => {
		await handlers.setStoryPriority({ input: input(), context: ctx });

		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "s-1", projectId: "p-1" },
			}),
		);
	});
});
