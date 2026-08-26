/**
 * Unit tests for `getTranscriptContentProcedure`.
 *
 * This procedure returns the FULL (never truncated) content of a single meeting
 * transcript, resolved by either `ProjectMeetingTranscript.id` OR its
 * `contextId`, project-scoped and tenant-XOR-safe, gated `PROJECT_READ`.
 *
 * Covered surfaces:
 *   - Resolves by `ProjectMeetingTranscript.id` AND by `contextId` (both `OR`
 *     paths) and returns the FULL `content` — explicitly NOT truncated to the
 *     3000-char `getTranscriptContextProcedure` cap.
 *   - Returns metadata fields: subject, ISO `meetingDate`, `speakerNames`,
 *     `wasSummarized`, ISO `syncedAt`.
 *   - `wasSummarized = true` with empty `ProjectContext.content` → falls back to
 *     `transcript.summary`.
 *   - `hasProjectAccess` false → `FORBIDDEN`.
 *   - Unknown ref / ref from another project → `NOT_FOUND` (project-scope guard).
 *   - Cross-tenant request (`getContextById` returns `null` under XOR) →
 *     `NOT_FOUND`.
 *   - Context resolved but `type !== "MEETING_TRANSCRIPT"` → `NOT_FOUND`.
 *   - Personal (`organizationId: null`) vs org tenant resolution both pass the
 *     right tenant to `getContextById`.
 *
 * Handler-capture + mocked-builder pattern mirrors the sibling
 * `set-auto-analyze.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		transcriptFindFirst: vi.fn(),
		getContextById: vi.fn(),
		hasProjectAccess: vi.fn(),
		requireProjectPermission: vi.fn(() => (c: unknown) => c),
	};
	return { handlers, mocks };
});

// Partial mock: keep every real export (so transitive top-level side effects
// still resolve) and override only `db`, `getContextById`, `hasProjectAccess`.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			projectMeetingTranscript: {
				findFirst: (...args: unknown[]) =>
					mocks.transcriptFindFirst(...args),
			},
		},
		getContextById: (...args: unknown[]) => mocks.getContextById(...args),
		hasProjectAccess: (...args: unknown[]) =>
			mocks.hasProjectAccess(...args),
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["getContent"];
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
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: (...args: unknown[]) =>
			mocks.requireProjectPermission(...args),
		// Mirror the real resolveOrganizationId contract closely enough for the
		// tenant-resolution assertions: an explicit org id is returned as-is;
		// null/undefined resolves to the session's active org (here: undefined,
		// i.e. personal context).
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			_session: unknown,
		) => organizationId ?? undefined,
	};
});

await import("../get-transcript-content");

const ctx = { user: { id: "user-1" }, session: {} };

// Helper: build a ProjectMeetingTranscript metadata row as returned by the
// `findFirst` select.
function makeTranscriptRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "transcript-1",
		contextId: "ctx-1",
		meetingSubject: "Sprint planning",
		meetingDate: new Date("2026-06-10T15:00:00.000Z"),
		speakerNames: ["Alice", "Bob"],
		wasSummarized: false,
		summary: null,
		syncedAt: new Date("2026-06-10T16:30:00.000Z"),
		...overrides,
	};
}

// Helper: build a ProjectContext row as returned by getContextById.
function makeContextRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		type: "MEETING_TRANSCRIPT",
		content: "# Sprint planning\n\nAlice: Hello\nBob: Hi",
		...overrides,
	};
}

beforeEach(() => {
	mocks.transcriptFindFirst.mockReset();
	mocks.getContextById.mockReset();
	mocks.hasProjectAccess.mockReset();
	mocks.hasProjectAccess.mockResolvedValue(true);
});

describe("getTranscriptContentProcedure — auth", () => {
	it("requires PROJECT_READ permission", () => {
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			"project:read",
		);
	});

	it("throws FORBIDDEN when hasProjectAccess is false (and never queries the transcript)", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.getContent({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptRef: "transcript-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.transcriptFindFirst).not.toHaveBeenCalled();
		expect(mocks.getContextById).not.toHaveBeenCalled();
	});
});

describe("getTranscriptContentProcedure — resolution by id / contextId (both OR paths)", () => {
	it("resolves by ProjectMeetingTranscript.id and returns the full transcript shape", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(makeContextRow());

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: Record<string, unknown> };

		// The findFirst query is project-scoped and accepts either identifier
		// via the OR clause (identifier columns only — never tenant columns).
		expect(mocks.transcriptFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				OR: [{ id: "transcript-1" }, { contextId: "transcript-1" }],
			},
			select: {
				id: true,
				contextId: true,
				meetingSubject: true,
				meetingDate: true,
				speakerNames: true,
				wasSummarized: true,
				summary: true,
				syncedAt: true,
			},
		});

		expect(result.transcript).toEqual({
			id: "transcript-1",
			contextId: "ctx-1",
			meetingSubject: "Sprint planning",
			meetingDate: "2026-06-10T15:00:00.000Z",
			speakerNames: ["Alice", "Bob"],
			wasSummarized: false,
			content: "# Sprint planning\n\nAlice: Hello\nBob: Hi",
			syncedAt: "2026-06-10T16:30:00.000Z",
		});
	});

	it("resolves when the ref is the contextId (the Context-tab row key)", async () => {
		// The Context-tab row is keyed by ProjectContext.id == transcript.contextId.
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(makeContextRow());

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "ctx-1",
			},
			context: ctx,
		})) as { transcript: { id: string; contextId: string } };

		expect(mocks.transcriptFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					OR: [{ id: "ctx-1" }, { contextId: "ctx-1" }],
				},
			}),
		);
		// The body is still fetched by the resolved row's contextId, not the ref.
		expect(mocks.getContextById).toHaveBeenCalledWith(
			"ctx-1",
			"project-1",
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(result.transcript.id).toBe("transcript-1");
		expect(result.transcript.contextId).toBe("ctx-1");
	});
});

describe("getTranscriptContentProcedure — full content (never truncated)", () => {
	it("returns the FULL content for content longer than the 3000-char AI cap", async () => {
		// getTranscriptContextProcedure truncates to MAX_CONTENT_LENGTH = 3000.
		// This reader procedure must NOT — assert a >3000-char body round-trips
		// byte-for-byte at its full length.
		const longContent = "A".repeat(8000);
		expect(longContent.length).toBeGreaterThan(3000);

		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(
			makeContextRow({ content: longContent }),
		);

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { content: string } };

		expect(result.transcript.content).toBe(longContent);
		expect(result.transcript.content.length).toBe(8000);
	});
});

describe("getTranscriptContentProcedure — metadata fields", () => {
	it("converts meetingDate and syncedAt to ISO strings and passes through speakerNames / wasSummarized / subject", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({
				meetingSubject: "Retro",
				meetingDate: new Date("2026-01-02T03:04:05.000Z"),
				speakerNames: ["Carol"],
				wasSummarized: true,
				summary: "summary text",
				syncedAt: new Date("2026-01-02T09:10:11.000Z"),
			}),
		);
		mocks.getContextById.mockResolvedValue(
			makeContextRow({ content: "non-empty body" }),
		);

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: Record<string, unknown> };

		expect(result.transcript.meetingSubject).toBe("Retro");
		expect(result.transcript.meetingDate).toBe("2026-01-02T03:04:05.000Z");
		expect(result.transcript.speakerNames).toEqual(["Carol"]);
		expect(result.transcript.wasSummarized).toBe(true);
		expect(result.transcript.syncedAt).toBe("2026-01-02T09:10:11.000Z");
	});

	it("returns a null meetingDate when the row has none", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({ meetingDate: null }),
		);
		mocks.getContextById.mockResolvedValue(makeContextRow());

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { meetingDate: string | null } };

		expect(result.transcript.meetingDate).toBeNull();
	});
});

describe("getTranscriptContentProcedure — summarized fallback", () => {
	it("falls back to transcript.summary when wasSummarized and the context body is empty", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({
				wasSummarized: true,
				summary: "An LLM summary of a very long meeting.",
			}),
		);
		mocks.getContextById.mockResolvedValue(
			makeContextRow({ content: "   \n  " }),
		);

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { content: string; wasSummarized: boolean } };

		expect(result.transcript.content).toBe(
			"An LLM summary of a very long meeting.",
		);
		expect(result.transcript.wasSummarized).toBe(true);
	});

	it("falls back to empty string when wasSummarized, body empty, and summary is null", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({ wasSummarized: true, summary: null }),
		);
		mocks.getContextById.mockResolvedValue(makeContextRow({ content: "" }));

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { content: string } };

		expect(result.transcript.content).toBe("");
	});

	it("returns the full context body (not the summary) when wasSummarized but the body is non-empty", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({
				wasSummarized: true,
				summary: "short summary",
			}),
		);
		mocks.getContextById.mockResolvedValue(
			makeContextRow({ content: "the full stored transcript body" }),
		);

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { content: string } };

		expect(result.transcript.content).toBe(
			"the full stored transcript body",
		);
	});

	it("returns the body verbatim (no summary fallback) when NOT summarized even if body is empty", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({ wasSummarized: false, summary: "ignored" }),
		);
		mocks.getContextById.mockResolvedValue(makeContextRow({ content: "" }));

		const result = (await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		})) as { transcript: { content: string } };

		// The summarized-fallback only triggers when wasSummarized is true, so a
		// non-summarized empty body comes back empty (the view's empty-body guard
		// handles presentation).
		expect(result.transcript.content).toBe("");
	});
});

describe("getTranscriptContentProcedure — NOT_FOUND guards", () => {
	it("throws NOT_FOUND when no transcript row matches (unknown / other-project ref)", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(null);

		await expect(
			handlers.getContent({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptRef: "does-not-exist",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// The body getter is never reached when the project-scoped lookup misses.
		expect(mocks.getContextById).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the matched row has no contextId", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(
			makeTranscriptRow({ contextId: null }),
		);

		await expect(
			handlers.getContent({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptRef: "transcript-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.getContextById).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when getContextById returns null (cross-tenant / cross-project XOR guard)", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(null);

		await expect(
			handlers.getContent({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptRef: "transcript-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("throws NOT_FOUND when the resolved context is not a MEETING_TRANSCRIPT", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(
			makeContextRow({ type: "LINK" }),
		);

		await expect(
			handlers.getContent({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptRef: "transcript-1",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("getTranscriptContentProcedure — tenant resolution (XOR)", () => {
	it("org context passes { organizationId } to getContextById", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(makeContextRow());

		await handlers.getContent({
			input: {
				projectId: "project-1",
				organizationId: "org-99",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		});

		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"org-99",
		);
		expect(mocks.getContextById).toHaveBeenCalledWith(
			"ctx-1",
			"project-1",
			{ userId: "user-1", organizationId: "org-99" },
		);
	});

	it("personal context (no organizationId) passes the resolved personal tenant to getContextById", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(makeTranscriptRow());
		mocks.getContextById.mockResolvedValue(makeContextRow());

		await handlers.getContent({
			input: {
				projectId: "project-1",
				transcriptRef: "transcript-1",
			},
			context: ctx,
		});

		// resolveOrganizationId(undefined, session) → undefined (personal).
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			undefined,
		);
		expect(mocks.getContextById).toHaveBeenCalledWith(
			"ctx-1",
			"project-1",
			{ userId: "user-1", organizationId: undefined },
		);
	});
});
