/**
 * Unit tests for the `listCalendarMeetings` handler's caching behavior.
 *
 * The handler builds on `tenantProtectedProcedure`; we mock that builder so its
 * `.handler(fn)` captures `fn`, then invoke it directly with a fake context and
 * mocked collaborators (project-access check, Microsoft Graph tool, and the
 * server-side meetings cache).
 *
 * Asserts:
 *  - a server-cache hit returns immediately and never calls Microsoft Graph,
 *  - a cache miss calls Graph and write-through caches the mapped result,
 *  - `forceRefresh` bypasses the cache read but still repopulates it,
 *  - the "Microsoft not connected" soft-error path is NOT cached,
 *  - the joinUrl filter is preserved (transcript access keys off joinUrl), and
 *  - missing project access throws and touches neither cache nor Graph.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	hasProjectAccessMock,
	executeTeamsToolMock,
	getCachedMock,
	setCachedMock,
	handlerHolder,
} = vi.hoisted(() => ({
	hasProjectAccessMock: vi.fn(),
	executeTeamsToolMock: vi.fn(),
	getCachedMock: vi.fn(),
	setCachedMock: vi.fn(),
	// Holder for the captured handler. Must live inside vi.hoisted so the
	// (hoisted) vi.mock factory below can reference it without hitting the
	// temporal dead zone.
	handlerHolder: {
		current: null as
			| ((opts: {
					input: Record<string, unknown>;
					context: Record<string, unknown>;
			  }) => Promise<unknown>)
			| null,
	},
}));

vi.mock("@repo/database", () => ({ hasProjectAccess: hasProjectAccessMock }));
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: executeTeamsToolMock,
}));
// NOTE: the +1 `../` vs the source file — vi.mock resolves relative to THIS
// test file (one level deeper, inside __tests__/).
vi.mock("../../../../../lib/meetings-cache", () => ({
	getCachedMeetings: getCachedMock,
	setCachedMeetings: setCachedMock,
}));

vi.mock("../../../../../orpc/procedures", () => ({
	Permissions: { PROJECT_READ: "PROJECT_READ" },
	requireProjectPermission: vi.fn(() => vi.fn()),
	resolveOrganizationId: vi.fn(
		(orgId: string | null | undefined) => orgId ?? null,
	),
	tenantProtectedProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		handler: vi.fn(function (
			this: unknown,
			fn: typeof handlerHolder.current,
		) {
			handlerHolder.current = fn;
			return this;
		}),
	},
}));

// Importing the module runs the builder chain and captures the handler.
import "../list-calendar-meetings";

const GRAPH_RESULT = {
	meetings: [
		{
			id: "m1",
			subject: "Sync",
			start: "2026-06-11T10:00:00Z",
			organizer: { emailAddress: { name: "Alice" } },
			joinUrl: "https://teams.microsoft.com/abc",
			isOnlineMeeting: true,
		},
	],
	count: 1,
};

const MAPPED = [
	{
		id: "m1",
		subject: "Sync",
		startTime: "2026-06-11T10:00:00Z",
		organizer: "Alice",
		joinUrl: "https://teams.microsoft.com/abc",
	},
];

function call(input: Record<string, unknown> = {}) {
	if (!handlerHolder.current) {
		throw new Error("handler was not captured — check the mock paths");
	}
	return handlerHolder.current({
		input: {
			projectId: "p1",
			organizationId: "org-1",
			daysBack: 30,
			forceRefresh: false,
			...input,
		},
		context: { user: { id: "user-1" }, session: {} },
	});
}

beforeEach(() => {
	hasProjectAccessMock.mockReset().mockResolvedValue(true);
	executeTeamsToolMock.mockReset().mockResolvedValue(GRAPH_RESULT);
	getCachedMock.mockReset().mockResolvedValue(null);
	setCachedMock.mockReset().mockResolvedValue(undefined);
});

describe("listCalendarMeetings handler — server cache", () => {
	it("returns the cached list and skips Microsoft Graph on a cache hit", async () => {
		getCachedMock.mockResolvedValue(MAPPED);
		const result = await call();
		expect(result).toEqual({ meetings: MAPPED });
		expect(getCachedMock).toHaveBeenCalledWith("user-1", "org-1", 30);
		expect(executeTeamsToolMock).not.toHaveBeenCalled();
		expect(setCachedMock).not.toHaveBeenCalled();
	});

	it("calls Graph on a miss and write-through caches the mapped result", async () => {
		const result = await call();
		expect(executeTeamsToolMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ meetings: MAPPED });
		expect(setCachedMock).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			30,
			MAPPED,
		);
	});

	it("bypasses the cache read when forceRefresh is true, then repopulates it", async () => {
		const result = await call({ forceRefresh: true });
		expect(getCachedMock).not.toHaveBeenCalled();
		expect(executeTeamsToolMock).toHaveBeenCalledTimes(1);
		expect(setCachedMock).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			30,
			MAPPED,
		);
		expect(result).toEqual({ meetings: MAPPED });
	});

	it("does NOT cache the 'Microsoft not connected' soft-error path", async () => {
		executeTeamsToolMock.mockRejectedValue(
			new Error(
				"Microsoft not connected. Please connect your Microsoft account.",
			),
		);
		const result = (await call()) as {
			meetings: unknown[];
			error?: string;
		};
		expect(result.meetings).toEqual([]);
		expect(result.error).toMatch(/Microsoft account not connected/);
		expect(setCachedMock).not.toHaveBeenCalled();
	});

	it("keeps only meetings with a joinUrl (transcript access keys off joinUrl)", async () => {
		executeTeamsToolMock.mockResolvedValue({
			meetings: [
				...GRAPH_RESULT.meetings,
				{
					id: "m2",
					subject: "No join link",
					start: "2026-06-10T09:00:00Z",
					organizer: { emailAddress: { name: "X" } },
					isOnlineMeeting: true,
				},
			],
			count: 2,
		});
		const result = (await call()) as { meetings: unknown[] };
		expect(result.meetings).toHaveLength(1);
		expect(setCachedMock).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			30,
			MAPPED,
		);
	});

	it("throws and touches neither cache nor Graph without project access", async () => {
		hasProjectAccessMock.mockResolvedValue(false);
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(getCachedMock).not.toHaveBeenCalled();
		expect(executeTeamsToolMock).not.toHaveBeenCalled();
		expect(setCachedMock).not.toHaveBeenCalled();
	});

	it("threads daysBack into the cache key AND the Graph window (not hard-coded 30)", async () => {
		await call({ daysBack: 7 });
		expect(getCachedMock).toHaveBeenCalledWith("user-1", "org-1", 7);
		expect(setCachedMock).toHaveBeenCalledWith(
			"user-1",
			"org-1",
			7,
			MAPPED,
		);
		const graphArgs = executeTeamsToolMock.mock.calls[0]?.[1] as {
			startDate: string;
			endDate: string;
		};
		const spanDays =
			(new Date(graphArgs.endDate).getTime() -
				new Date(graphArgs.startDate).getTime()) /
			86_400_000;
		expect(Math.round(spanDays)).toBe(7);
	});

	it("resolves personal context (organizationId null) into the cache key", async () => {
		await call({ organizationId: null });
		expect(getCachedMock).toHaveBeenCalledWith("user-1", null, 30);
		expect(setCachedMock).toHaveBeenCalledWith("user-1", null, 30, MAPPED);
	});

	it("does NOT cache a generic Graph failure (only successful results are cached)", async () => {
		executeTeamsToolMock.mockRejectedValue(new Error("Graph 500: boom"));
		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
		expect(setCachedMock).not.toHaveBeenCalled();
	});
});
