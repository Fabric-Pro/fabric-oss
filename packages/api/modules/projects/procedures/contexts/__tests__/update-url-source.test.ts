/**
 * Unit tests for `updateUrlSourceProcedure` — URL Context Sources spec §6.2 + §7.2.
 *
 * Covers:
 *   - Only fields the caller supplied are patched (sparse update).
 *   - Cadence change DAILY → WEEKLY routes through `updateUrlSourceSchedule`
 *     and persists the returned `scheduleId`.
 *   - Switching INTO a scheduled mode without a Firecrawl key → BAD_REQUEST
 *     with `FIRECRAWL_NOT_CONFIGURED` payload.
 *   - Switching OUT of a scheduled mode to ONCE → schedule deleted,
 *     `urlScheduleId` cleared to null.
 *   - NOT_FOUND when contextId is for a different tenant (XOR).
 *   - BAD_REQUEST when target is not a LINK row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockGetContextById,
	mockProjectContextUpdate,
	mockGetSearchProviderConfig,
	mockOrgFindUnique,
	mockDecryptApiKey,
	mockGetScheduleClient,
	mockUpdateUrlSourceSchedule,
	mockIsScheduledMode,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockGetContextById: vi.fn(),
	mockProjectContextUpdate: vi.fn(),
	mockGetSearchProviderConfig: vi.fn(),
	mockOrgFindUnique: vi.fn(),
	mockDecryptApiKey: vi.fn(),
	mockGetScheduleClient: vi.fn(),
	mockUpdateUrlSourceSchedule: vi.fn(),
	mockIsScheduledMode: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: { update: mockProjectContextUpdate },
		organization: { findUnique: mockOrgFindUnique },
	},
	getContextById: mockGetContextById,
	getSearchProviderConfig: mockGetSearchProviderConfig,
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: mockDecryptApiKey,
}));

vi.mock("@repo/temporal", () => ({
	getScheduleClient: mockGetScheduleClient,
	updateUrlSourceSchedule: mockUpdateUrlSourceSchedule,
	isScheduledMode: mockIsScheduledMode,
	MissingFirecrawlKeyError: class MissingFirecrawlKeyError extends Error {
		name = "MissingFirecrawlKeyError";
	},
	// `cadenceNextFireUtc` is invoked on every cadence change to recompute
	// `urlNextRefreshAt`. Real impl returns next-midnight-UTC for
	// DAILY/WEEKLY/MONTHLY, `null` for ONCE/LIVE. The test mock collapses
	// to a sentinel Date so we can pin assertions by reference identity.
	cadenceNextFireUtc: vi.fn((mode: string | null | undefined) =>
		mode === "DAILY" || mode === "WEEKLY" || mode === "MONTHLY"
			? new Date("2099-01-01T00:00:00.000Z")
			: null,
	),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		contextId: string;
		projectId: string;
		organizationId?: string | null;
		label?: string;
		scope?: "SINGLE_PAGE" | "PATH_PREFIX";
		maxPages?: number;
		refreshMode?: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "LIVE";
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-url-source");
	return (mod.updateUrlSourceProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

const SCHEDULED = new Set(["DAILY", "WEEKLY", "MONTHLY"]);

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetScheduleClient.mockResolvedValue({}); // unused — helper is mocked
	mockIsScheduledMode.mockImplementation(
		(mode: string | null | undefined) =>
			mode != null && SCHEDULED.has(mode),
	);
	mockDecryptApiKey.mockReturnValue("decrypted-fc-key");
});

describe("updateUrlSource — maxPages bounds", () => {
	// Aligned with process-context-link.ts: MAX_MAX_PAGES = 500. Upper bound
	// is tuned to the worker's concurrency-1 wall clock (~85 min at 500
	// pages). Default 200 keeps Firecrawl spend low on the common case.
	it("accepts maxPages = 500 (matches the create procedure's upper bound)", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-bump",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Help Center",
			sourceUrl: "https://help.acme.com/hc/en-us",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-bump",
			sourceTitle: "Help Center",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 500,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-bump",
				projectId: "proj-1",
				maxPages: 500,
			},
			context: personalCtx,
		})) as { maxPages: number };

		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { urlMaxPages: 500 },
			}),
		);
		expect(result.maxPages).toBe(500);
	});
});

describe("updateUrlSource — lock while crawling", () => {
	// Mirror the API-level CONFLICT guard. The Settings card is also
	// disabled in the UI, but a stale tab or a concurrent user in the
	// same org could still POST here — the server is the source of truth.
	it.each([["PENDING"], ["EXTRACTING"]])(
		"rejects with CONFLICT when extractionStatus is %s",
		async (status) => {
			mockGetContextById.mockResolvedValue({
				id: "ctx-1",
				projectId: "proj-1",
				type: "LINK",
				sourceUrl: "https://example.com",
				urlScope: "SINGLE_PAGE",
				urlMaxPages: null,
				urlRefreshMode: "ONCE",
				urlScheduleId: null,
				extractionStatus: status,
			});

			const handler = await loadHandler();
			await expect(
				handler({
					input: {
						contextId: "ctx-1",
						projectId: "proj-1",
						label: "Trying to rename mid-crawl",
					},
					context: personalCtx,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });

			expect(mockProjectContextUpdate).not.toHaveBeenCalled();
		},
	);

	it.each([["COMPLETED"], ["FAILED"], ["CANCELLED"]])(
		"allows update when extractionStatus is terminal (%s)",
		async (status) => {
			mockGetContextById.mockResolvedValue({
				id: "ctx-1",
				projectId: "proj-1",
				type: "LINK",
				sourceTitle: "Old",
				sourceUrl: "https://example.com",
				urlScope: "SINGLE_PAGE",
				urlMaxPages: null,
				urlRefreshMode: "ONCE",
				urlScheduleId: null,
				extractionStatus: status,
			});
			mockProjectContextUpdate.mockResolvedValue({
				id: "ctx-1",
				sourceTitle: "New",
				urlScope: "SINGLE_PAGE",
				urlMaxPages: null,
				urlRefreshMode: "ONCE",
				urlScheduleId: null,
			});

			const handler = await loadHandler();
			const result = (await handler({
				input: {
					contextId: "ctx-1",
					projectId: "proj-1",
					label: "New",
				},
				context: personalCtx,
			})) as { label: string };

			expect(result.label).toBe("New");
			expect(mockProjectContextUpdate).toHaveBeenCalled();
		},
	);
});

describe("updateUrlSource — sparse update", () => {
	it("only patches fields the caller supplied", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Old Title",
			sourceUrl: "https://example.com",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-1",
			sourceTitle: "New Title",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				label: "New Title",
			},
			context: personalCtx,
		})) as { label: string; scheduleAction: string };

		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "ctx-1" },
				data: { sourceTitle: "New Title" },
			}),
		);
		expect(result.label).toBe("New Title");
		expect(result.scheduleAction).toBe("noop");
		expect(mockUpdateUrlSourceSchedule).not.toHaveBeenCalled();
	});
});

describe("updateUrlSource — cadence change schedule lifecycle", () => {
	it("DAILY → WEEKLY routes through updateUrlSourceSchedule and persists new id", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-sched",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			sourceUrl: "https://example.com/docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "DAILY",
			urlScheduleId: "url-source-schedule-ctx-sched",
		});
		mockGetSearchProviderConfig.mockResolvedValue({
			encryptedApiKey: "enc-key",
			endpoint: null,
			enabled: true,
			source: "user",
		});
		mockUpdateUrlSourceSchedule.mockResolvedValue({
			scheduleId: "url-source-schedule-ctx-sched",
			action: "updated",
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-sched",
			sourceTitle: "Docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "WEEKLY",
			urlScheduleId: "url-source-schedule-ctx-sched",
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-sched",
				projectId: "proj-1",
				refreshMode: "WEEKLY",
			},
			context: personalCtx,
		})) as { scheduleAction: string; urlScheduleId: string | null };

		expect(result.scheduleAction).toBe("updated");
		expect(result.urlScheduleId).toBe("url-source-schedule-ctx-sched");
		expect(mockUpdateUrlSourceSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-sched",
				oldRefreshMode: "DAILY",
				newRefreshMode: "WEEKLY",
				apiKey: "decrypted-fc-key",
			}),
			expect.anything(),
		);
		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					urlRefreshMode: "WEEKLY",
					urlScheduleId: "url-source-schedule-ctx-sched",
				}),
			}),
		);
	});

	it("DAILY → ONCE deletes schedule, clears urlScheduleId", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-d",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			sourceUrl: "https://example.com/docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "DAILY",
			urlScheduleId: "url-source-schedule-ctx-d",
		});
		mockUpdateUrlSourceSchedule.mockResolvedValue({
			scheduleId: null,
			action: "deleted",
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-d",
			sourceTitle: "Docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-d",
				projectId: "proj-1",
				refreshMode: "ONCE",
			},
			context: personalCtx,
		})) as { scheduleAction: string; urlScheduleId: string | null };

		expect(result.scheduleAction).toBe("deleted");
		expect(result.urlScheduleId).toBeNull();
		// Switching OUT of scheduled doesn't need an apiKey — assert the
		// procedure didn't try to resolve one.
		expect(mockGetSearchProviderConfig).not.toHaveBeenCalled();
		// `urlNextRefreshAt` must be cleared to null when switching to
		// ONCE so the sidebar's "Next refresh" row collapses to em-dash.
		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					urlRefreshMode: "ONCE",
					urlNextRefreshAt: null,
				}),
			}),
		);
	});

	it("DAILY happy path stamps urlNextRefreshAt with next-fire sentinel", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-stamp",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			sourceUrl: "https://example.com/docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});
		mockGetSearchProviderConfig.mockResolvedValue({
			encryptedApiKey: "enc-key",
			endpoint: null,
			enabled: true,
			source: "user",
		});
		mockUpdateUrlSourceSchedule.mockResolvedValue({
			scheduleId: "url-source-schedule-ctx-stamp",
			action: "created",
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-stamp",
			sourceTitle: "Docs",
			urlScope: "PATH_PREFIX",
			urlMaxPages: 100,
			urlRefreshMode: "DAILY",
			urlScheduleId: "url-source-schedule-ctx-stamp",
		});

		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-stamp",
				projectId: "proj-1",
				refreshMode: "DAILY",
			},
			context: personalCtx,
		});

		expect(mockProjectContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					urlRefreshMode: "DAILY",
					urlNextRefreshAt: new Date("2099-01-01T00:00:00.000Z"),
				}),
			}),
		);
	});

	it("ONCE → DAILY without a Firecrawl key returns BAD_REQUEST FIRECRAWL_NOT_CONFIGURED", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-no-key",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Docs",
			sourceUrl: "https://example.com/docs",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});
		mockGetSearchProviderConfig.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					contextId: "ctx-no-key",
					projectId: "proj-1",
					refreshMode: "DAILY",
				},
				context: personalCtx,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "FIRECRAWL_NOT_CONFIGURED" },
		});
		expect(mockUpdateUrlSourceSchedule).not.toHaveBeenCalled();
		expect(mockProjectContextUpdate).not.toHaveBeenCalled();
	});

	it("does NOT rotate schedule when refreshMode stays ONCE", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-once",
			projectId: "proj-1",
			type: "LINK",
			sourceTitle: "Article",
			sourceUrl: "https://example.com",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});
		mockProjectContextUpdate.mockResolvedValue({
			id: "ctx-once",
			sourceTitle: "Article",
			urlScope: "SINGLE_PAGE",
			urlMaxPages: null,
			urlRefreshMode: "ONCE",
			urlScheduleId: null,
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-once",
				projectId: "proj-1",
				refreshMode: "ONCE",
			},
			context: personalCtx,
		})) as { scheduleAction: string };

		expect(result.scheduleAction).toBe("noop");
		expect(mockUpdateUrlSourceSchedule).not.toHaveBeenCalled();
	});
});

describe("updateUrlSource — tenant + type guards", () => {
	it("returns NOT_FOUND when the context belongs to a different tenant", async () => {
		mockGetContextById.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-other-tenant", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns BAD_REQUEST when target is not a LINK context", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-file",
			projectId: "proj-1",
			type: "FILE",
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-file", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
