import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		applyPriorityChanges: vi.fn(),
		userStoryFindMany: vi.fn(),
		userStoryFindFirst: vi.fn(),
		projectStoryStatusFindMany: vi.fn(),
		getAcceptedDecisionsForGuidance: vi.fn(),
		getOpenDecisionsForStories: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		renderTemplate: vi.fn(),
		recordAudit: vi.fn(),
		trackUsage: vi.fn(),
	};
	return { handlers, mocks };
});

class AIProviderNotConfiguredError extends Error {}

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError,
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
	zodSchema: (s: unknown) => s,
}));

vi.mock("@repo/database", () => ({
	applyPriorityChanges: mocks.applyPriorityChanges,
	getAcceptedDecisionsForGuidance: mocks.getAcceptedDecisionsForGuidance,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	getOpenDecisionsForStories: mocks.getOpenDecisionsForStories,
	db: {
		userStory: {
			findMany: mocks.userStoryFindMany,
			findFirst: mocks.userStoryFindFirst,
		},
		projectStoryStatus: { findMany: mocks.projectStoryStatusFindMany },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/utils", () => ({ renderTemplate: mocks.renderTemplate }));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	// Declaration order in ../reprioritize-stories.ts — a new `.handler()` call
	// there must be mirrored here or every later key shifts.
	const importedHandlerKeys = ["reprioritize", "reprioritizeStory"];
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

const {
	normalisePriority,
	PRIORITY_REPRIORITIZATION_PROMPT_FALLBACK_BODY,
	PRIORITY_REPRIORITIZATION_SINGLE_PROMPT_FALLBACK_BODY,
} = await import("../reprioritize-stories");

const ctx = {
	user: { id: "u-1", name: "A. Diaz" },
	session: {},
};

function story(id: string, priority: string) {
	return {
		id,
		identifier: `F-${id}`,
		title: `Story ${id}`,
		priority,
		kind: "FEATURE",
		draftingStage: "DRAFT",
		blocked: false,
		blockedReason: null,
		createdAt: new Date("2026-07-01T00:00:00Z"),
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: mocks.trackUsage,
	});
	mocks.getBoundPromptForAgent.mockResolvedValue(null);
	mocks.renderTemplate.mockResolvedValue({ rendered: "prompt", error: null });
	mocks.getOpenDecisionsForStories.mockResolvedValue({
		counts: {},
		questions: {},
	});
	mocks.applyPriorityChanges.mockResolvedValue([]);
	mocks.projectStoryStatusFindMany.mockResolvedValue([]);
	mocks.getAcceptedDecisionsForGuidance.mockResolvedValue([]);
});

describe("prompt / seed parity", () => {
	// Both files carry a comment promising the two bodies are byte-identical,
	// and nothing enforced it. They diverge the moment someone tunes one — and
	// the symptom is invisible: envs that ran the seed behave differently from
	// envs that fall back, with no error anywhere.
	it("the seeded prompt body matches the in-code fallback exactly", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const seedPath = path.resolve(
			import.meta.dirname,
			"../../../../../../database/prisma/seed-prompts-only.ts",
		);
		const source = await fs.readFile(seedPath, "utf8");

		// Pull the template literal assigned to `content:` inside the
		// priority_reprioritization entry.
		const entry = source.slice(
			source.indexOf('key: "priority_reprioritization"'),
		);
		const start = entry.indexOf("content: `") + "content: `".length;
		const end = entry.indexOf("`,", start);
		const seeded = entry.slice(start, end);

		expect(seeded.length).toBeGreaterThan(200);
		expect(seeded).toBe(PRIORITY_REPRIORITIZATION_PROMPT_FALLBACK_BODY);
	});

	// The tag-guidance sync migration rewrites deployed prompt bodies with
	// replace() against literal anchors. replace() fails SILENTLY: if the
	// in-code prompt drifts from the anchor text, deployed environments keep
	// serving the old body and nothing errors. Pin the anchors here so that
	// drift breaks a test instead of a deploy.
	it("the sync migration's replacement anchors still exist in the shipped prompts", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const migrationPath = path.resolve(
			import.meta.dirname,
			"../../../../../../database/prisma/migrations/20260826090000_sync_reprioritization_priority_tag_guidance/migration.sql",
		);
		const sql = await fs.readFile(migrationPath, "utf8");

		// Every $tag$-quoted NEW body the migration installs must be present
		// verbatim in the prompt the code ships, or the two have diverged.
		const replacements = [
			"Decisions tagged PRIORITY are the team's explicit ranking guidance and outweigh untagged ones.",
			"Each may carry a PRIORITY and/or long-standing/short-term tag:",
		];
		for (const fragment of replacements) {
			expect(sql).toContain(fragment);
			expect(PRIORITY_REPRIORITIZATION_PROMPT_FALLBACK_BODY).toContain(
				fragment,
			);
		}
	});
});

describe("normalisePriority", () => {
	it("accepts the canonical enum values", () => {
		expect(normalisePriority("P0_CRITICAL")).toBe("P0_CRITICAL");
		expect(normalisePriority("P3_LOW")).toBe("P3_LOW");
	});

	it("accepts the short tier form models actually emit", () => {
		expect(normalisePriority("P0")).toBe("P0_CRITICAL");
		expect(normalisePriority("p1")).toBe("P1_HIGH");
		expect(normalisePriority("  P2  ")).toBe("P2_MEDIUM");
	});

	it("accepts the spelled-out severity", () => {
		expect(normalisePriority("Critical")).toBe("P0_CRITICAL");
		expect(normalisePriority("high")).toBe("P1_HIGH");
	});

	it("returns null for anything it cannot map, rather than guessing", () => {
		expect(normalisePriority("urgent-ish")).toBeNull();
		expect(normalisePriority("")).toBeNull();
		expect(normalisePriority("P9")).toBeNull();
	});
});

describe("reprioritize — only real moves are written", () => {
	it("passes every assignment through, letting the DB layer drop no-ops", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			story("a", "P2_MEDIUM"),
			story("b", "P1_HIGH"),
		]);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					// Genuinely moved.
					{
						storyId: "a",
						priority: "P0",
						rationale: "Security exposure",
					},
					// Model agreed with the current band — no rationale given.
					{ storyId: "b", priority: "P1_HIGH" },
				],
			},
			usage: {},
		});
		mocks.applyPriorityChanges.mockResolvedValue([
			{
				storyId: "a",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
			},
		]);

		const result = await handlers.reprioritize({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: ["a", "b"],
			},
			context: ctx,
		});

		const [, requests, source] = mocks.applyPriorityChanges.mock.calls[0];
		expect(source).toBe("AI");
		expect(requests).toEqual([
			{
				storyId: "a",
				toPriority: "P0_CRITICAL",
				reason: "Security exposure",
			},
			{ storyId: "b", toPriority: "P1_HIGH", reason: null },
		]);
		// Only the item the DB layer actually moved comes back.
		expect(result.changed).toEqual([
			{
				storyId: "a",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
				rationale: "Security exposure",
			},
		]);
		expect(result.considered).toBe(2);
	});

	// Deliberate change (round-5 review): a run that moved nothing still writes
	// one audit row — "someone ran AI triage" is auditable in itself, and the
	// PRIORITY HISTORY (not the audit log) is what stays silent on no-ops.
	it("records one story.reprioritized audit row even when the run moved nothing", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ storyId: "a", priority: "P2_MEDIUM" }] },
			usage: {},
		});
		mocks.applyPriorityChanges.mockResolvedValue([]);

		const result = await handlers.reprioritize({
			input: { projectId: "p-1", organizationId: null, storyIds: ["a"] },
			context: ctx,
		});

		expect(result.changed).toEqual([]);
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.reprioritized",
				// A run is a batch over the project, not an edit of one story —
				// so the resource is the project itself.
				resource: expect.objectContaining({
					type: "project",
					id: "p-1",
				}),
				metadata: expect.objectContaining({
					considered: 1,
					changed: 0,
				}),
			}),
		);
	});

	it("drops hallucinated ids and unparseable bands", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ storyId: "not-a-real-id", priority: "P0" },
					{ storyId: "a", priority: "extremely urgent" },
				],
			},
			usage: {},
		});

		await handlers.reprioritize({
			input: { projectId: "p-1", organizationId: null, storyIds: ["a"] },
			context: ctx,
		});

		const [, requests] = mocks.applyPriorityChanges.mock.calls[0];
		expect(requests).toEqual([]);
	});

	it("collapses a duplicated id to its first assignment", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ storyId: "a", priority: "P0" },
					{ storyId: "a", priority: "P3" },
				],
			},
			usage: {},
		});

		await handlers.reprioritize({
			input: { projectId: "p-1", organizationId: null, storyIds: ["a"] },
			context: ctx,
		});

		const [, requests] = mocks.applyPriorityChanges.mock.calls[0];
		expect(requests).toHaveLength(1);
		expect(requests[0].toPriority).toBe("P0_CRITICAL");
	});
});

describe("reprioritize — cost and failure boundaries", () => {
	it("ranks a large-but-in-ceiling list in full, without truncating", async () => {
		// 130 > the old 100 cap but well under the 500 ceiling: the whole set is
		// re-assessed in one pass, so nothing is dropped and nothing is flagged.
		const many = Array.from({ length: 130 }, (_, i) =>
			story(String(i), "P2_MEDIUM"),
		);
		mocks.userStoryFindMany.mockResolvedValue(many);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [] },
			usage: {},
		});

		const result = await handlers.reprioritize({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: many.map((s) => s.id),
			},
			context: ctx,
		});

		expect(result.considered).toBe(130);
		expect(result.truncated).toBe(false);
		// One pass over the whole set — the model sees the list as one set so
		// its bands are relative across all items, not per-chunk.
		expect(mocks.generateObject).toHaveBeenCalledTimes(1);
	});

	it("caps the model input at 500 items and reports the truncation", async () => {
		const many = Array.from({ length: 520 }, (_, i) =>
			story(String(i), "P2_MEDIUM"),
		);
		mocks.userStoryFindMany.mockResolvedValue(many);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [] },
			usage: {},
		});

		const result = await handlers.reprioritize({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyIds: many.map((s) => s.id),
			},
			context: ctx,
		});

		expect(result.considered).toBe(500);
		expect(result.truncated).toBe(true);
	});

	it("surfaces an unconfigured provider instead of silently doing nothing", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.getAIModelWithMetadata.mockRejectedValue(
			new AIProviderNotConfiguredError("no provider"),
		);

		await expect(
			handlers.reprioritize({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyIds: ["a"],
				},
				context: ctx,
			}),
		).rejects.toThrow();
		expect(mocks.applyPriorityChanges).not.toHaveBeenCalled();
	});

	it("never sends the caller's own priorities to the model — it reads them from the DB", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [] },
			usage: {},
		});

		await handlers.reprioritize({
			input: { projectId: "p-1", organizationId: null, storyIds: ["a"] },
			context: ctx,
		});

		// The story load is scoped to the authorised project, so an id from
		// another tenant's project matches nothing.
		expect(mocks.userStoryFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["a"] }, projectId: "p-1" },
			}),
		);
		// The band reaches the model as a human label, not the storage enum —
		// staging showed the model echoing "P2_MEDIUM" straight into prose a
		// person reads.
		const [{ variables }] = mocks.renderTemplate.mock.calls[0];
		expect(variables.workItems).toContain("currentPriority=P2 (Medium)");
		expect(variables.workItems).not.toContain("P2_MEDIUM");
		// No confirmed decisions in this project → an explicit empty guidance
		// line, so the model still gets a well-formed prompt.
		expect(variables.decisionGuidance).toContain("none recorded");
	});

	it("passes the project's confirmed decisions to the prompt as guidance", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story("a", "P2_MEDIUM")]);
		mocks.getAcceptedDecisionsForGuidance.mockResolvedValue([
			{
				identifier: "ADR-001",
				title: "Adopt passkeys",
				decision: "All new auth flows use passkeys first.",
				domain: "security",
			},
		]);
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [] },
			usage: {},
		});

		await handlers.reprioritize({
			input: { projectId: "p-1", organizationId: null, storyIds: ["a"] },
			context: ctx,
		});

		expect(mocks.getAcceptedDecisionsForGuidance).toHaveBeenCalledWith({
			projectId: "p-1",
		});
		const [{ variables }] = mocks.renderTemplate.mock.calls[0];
		expect(variables.decisionGuidance).toContain("ADR-001 Adopt passkeys");
		expect(variables.decisionGuidance).toContain("[security]");
	});
});

// ---------------------------------------------------------------------------
// reprioritizeStory — the per-item sparkle
// ---------------------------------------------------------------------------

function singleTarget(overrides: Record<string, unknown> = {}) {
	return {
		...story("t", "P2_MEDIUM"),
		statusId: "status-open",
		...overrides,
	};
}

describe("reprioritizeStory — prompt / seed parity", () => {
	// Same invisible-divergence failure mode as the batch prompt above.
	it("the seeded single-item prompt body matches the in-code fallback exactly", async () => {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const seedPath = path.resolve(
			import.meta.dirname,
			"../../../../../../database/prisma/seed-prompts-only.ts",
		);
		const source = await fs.readFile(seedPath, "utf8");

		const entry = source.slice(
			source.indexOf('key: "priority_reprioritization_single"'),
		);
		const start = entry.indexOf("content: `") + "content: `".length;
		const end = entry.indexOf("`,", start);
		const seeded = entry.slice(start, end);

		expect(seeded.length).toBeGreaterThan(200);
		expect(seeded).toBe(
			PRIORITY_REPRIORITIZATION_SINGLE_PROMPT_FALLBACK_BODY,
		);
	});
});

describe("reprioritizeStory — isolated mode", () => {
	it("assesses the target alone and applies the returned band", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.generateObject.mockResolvedValue({
			object: { priority: "P0", rationale: "Blocks the release." },
			usage: {},
		});
		mocks.applyPriorityChanges.mockResolvedValue([
			{
				storyId: "t",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
			},
		]);

		const result = (await handlers.reprioritizeStory({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyId: "t",
				withListContext: false,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result.changed).toBe(true);
		expect(result.fromPriority).toBe("P2_MEDIUM");
		expect(result.toPriority).toBe("P0_CRITICAL");
		expect(result.rationale).toBe("Blocks the release.");
		expect(result.considered).toBe(1);

		// Isolated = no peer query at all, and the prompt says so explicitly.
		expect(mocks.userStoryFindMany).not.toHaveBeenCalled();
		const [{ variables }] = mocks.renderTemplate.mock.calls[0];
		expect(variables.contextItems).toContain("none");
		expect(variables.targetItem).toContain("F-t");

		expect(mocks.applyPriorityChanges).toHaveBeenCalledWith(
			"p-1",
			[
				{
					storyId: "t",
					toPriority: "P0_CRITICAL",
					reason: "Blocks the release.",
				},
			],
			"AI",
			{ id: "u-1", name: "A. Diaz" },
		);
	});

	it("reports an explicit no-change when the band already fits", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.generateObject.mockResolvedValue({
			object: { priority: "P2" },
			usage: {},
		});
		// The DB layer drops the no-op — nothing applied.
		mocks.applyPriorityChanges.mockResolvedValue([]);

		const result = (await handlers.reprioritizeStory({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyId: "t",
				withListContext: false,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result.changed).toBe(false);
		expect(result.fromPriority).toBeNull();
		expect(result.toPriority).toBeNull();
		expect(result.rationale).toBeNull();
	});

	it("records the run in the audit ledger with the single-item via", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.generateObject.mockResolvedValue({
			object: { priority: "P2" },
			usage: {},
		});

		await handlers.reprioritizeStory({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyId: "t",
				withListContext: false,
			},
			context: ctx,
		});

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.reprioritized",
				metadata: expect.objectContaining({
					via: "priority-reprioritize-single",
					storyId: "t",
				}),
			}),
		);
	});

	it("surfaces an unparseable band as a retryable failure, not a silent no-change", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.generateObject.mockResolvedValue({
			object: { priority: "urgent-ish" },
			usage: {},
		});

		await expect(
			handlers.reprioritizeStory({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyId: "t",
					withListContext: false,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.applyPriorityChanges).not.toHaveBeenCalled();
	});
});

describe("reprioritizeStory — eligibility", () => {
	it("refuses a hidden (CLOSED) target", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(
			singleTarget({ draftingStage: "CLOSED" }),
		);

		await expect(
			handlers.reprioritizeStory({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyId: "t",
					withListContext: false,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.generateObject).not.toHaveBeenCalled();
	});

	it("refuses a completed (final-status) target", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.projectStoryStatusFindMany.mockResolvedValue([
			{ id: "status-open" },
		]);

		await expect(
			handlers.reprioritizeStory({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyId: "t",
					withListContext: false,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("404s a story outside the authorised project", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.reprioritizeStory({
				input: {
					projectId: "p-1",
					organizationId: null,
					storyId: "other-tenant",
					withListContext: false,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("reprioritizeStory — list context", () => {
	it("sends active same-kind peers as read-only context, excluding hidden/declined/completed", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(singleTarget());
		mocks.projectStoryStatusFindMany.mockResolvedValue([
			{ id: "status-done" },
		]);
		mocks.userStoryFindMany.mockResolvedValue([
			{ ...story("peer", "P1_HIGH"), statusId: "status-open" },
		]);
		mocks.generateObject.mockResolvedValue({
			object: { priority: "P2" },
			usage: {},
		});

		const result = (await handlers.reprioritizeStory({
			input: {
				projectId: "p-1",
				organizationId: null,
				storyId: "t",
				withListContext: true,
			},
			context: ctx,
		})) as Record<string, unknown>;

		expect(result.considered).toBe(2);
		expect(mocks.userStoryFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "p-1",
					kind: "FEATURE",
					id: { not: "t" },
					draftingStage: { notIn: ["CLOSED", "DECLINED"] },
					statusId: { notIn: ["status-done"] },
				}),
				// Peer cap is the run ceiling minus the target's own slot.
				take: 499,
			}),
		);

		const [{ variables }] = mocks.renderTemplate.mock.calls[0];
		expect(variables.targetItem).toContain("F-t");
		expect(variables.contextItems).toContain("F-peer");
		// Only the target can ever be written — the peer is context, and the
		// apply request names exactly one story.
		expect(mocks.applyPriorityChanges).toHaveBeenCalledWith(
			"p-1",
			[expect.objectContaining({ storyId: "t" })],
			"AI",
			expect.anything(),
		);
	});
});
