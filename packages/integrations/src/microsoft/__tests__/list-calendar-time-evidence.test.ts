import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: vi.fn(),
	db: {
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { resolveWorkflowIntegrationForProvider } from "@repo/database";
import { executeMicrosoftTeamsTool } from "../index";

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example-series";
const ARGS = {
	startDate: "2026-11-02T00:00:00.000Z",
	endDate: "2026-11-09T00:00:00.000Z",
};

function page(value: unknown[], nextLink?: string) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({
			value,
			...(nextLink ? { "@odata.nextLink": nextLink } : {}),
		}),
	};
}

describe("executeMicrosoftTeamsTool('list_calendar_time_evidence')", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
		findFirstIntegration.mockResolvedValue({
			id: "integration-own",
			credentials: JSON.stringify({ access_token: "graph-test-token" }),
			settings: { email: "dev@example.com", name: "Dev Example" },
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("selects no subject, organizer or attendees, and asks for UTC times", async () => {
		fetchMock.mockResolvedValue(page([]));

		await executeMicrosoftTeamsTool(
			"list_calendar_time_evidence",
			ARGS,
			"user-1",
			"org-1",
			"integration-own",
		);

		const [url, init] = fetchMock.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		const params = new URL(url).searchParams;
		expect(new URL(url).pathname).toBe("/v1.0/me/calendarView");
		expect(params.get("startDateTime")).toBe(ARGS.startDate);
		expect(params.get("endDateTime")).toBe(ARGS.endDate);
		expect(params.get("$select")?.split(",").sort()).toEqual(
			[
				"id",
				"start",
				"end",
				"isAllDay",
				"isCancelled",
				"showAs",
				"responseStatus",
				"isOrganizer",
				"onlineMeeting",
			].sort(),
		);
		expect(init.headers.Prefer).toBe('outlook.timezone="UTC"');
	});

	it("reads through the pinned own connection, never resolving a shared one", async () => {
		fetchMock.mockResolvedValue(page([]));

		await executeMicrosoftTeamsTool(
			"list_calendar_time_evidence",
			ARGS,
			"user-1",
			"org-1",
			"integration-own",
		);

		expect(resolveWorkflowIntegrationForProvider).not.toHaveBeenCalled();
		expect(findFirstIntegration.mock.calls[0][0].where).toMatchObject({
			id: "integration-own",
			provider: "MICROSOFT_GRAPH",
			isActive: true,
		});
	});

	it("returns only ids, UTC times, the join URL and the response, and drops events without one", async () => {
		fetchMock.mockResolvedValue(
			page([
				{
					id: "event-1",
					subject: "Weekly sync",
					organizer: {
						emailAddress: { address: "dev@example.com" },
					},
					start: { dateTime: "2026-11-03T09:00:00.0000000" },
					end: { dateTime: "2026-11-03T09:30:00.0000000" },
					isAllDay: false,
					showAs: "busy",
					responseStatus: { response: "tentativelyAccepted" },
					isOrganizer: false,
					onlineMeeting: { joinUrl: JOIN_URL },
				},
				{
					id: "event-2",
					start: { dateTime: "2026-11-03T12:00:00.0000000" },
					end: { dateTime: "2026-11-03T13:00:00.0000000" },
					onlineMeeting: null,
				},
			]),
		);

		const result = await executeMicrosoftTeamsTool(
			"list_calendar_time_evidence",
			ARGS,
			"user-1",
			"org-1",
			"integration-own",
		);

		expect(result).toEqual({
			events: [
				{
					id: "event-1",
					startAt: "2026-11-03T09:00:00.000Z",
					endAt: "2026-11-03T09:30:00.000Z",
					joinUrl: JOIN_URL,
					isAllDay: false,
					isCancelled: false,
					showAs: "busy",
					response: "tentativelyAccepted",
					isOrganizer: false,
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("Weekly sync");
		expect(JSON.stringify(result)).not.toContain("dev@example.com");
	});

	it("follows the next page link up to twenty pages", async () => {
		fetchMock.mockImplementation(async () =>
			page(
				[],
				"https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
			),
		);

		await executeMicrosoftTeamsTool(
			"list_calendar_time_evidence",
			ARGS,
			"user-1",
			"org-1",
			"integration-own",
		);

		expect(fetchMock).toHaveBeenCalledTimes(20);
	});

	it("reads nothing once the caller's deadline has passed", async () => {
		const controller = new AbortController();
		controller.abort(new Error("deadline"));

		await expect(
			executeMicrosoftTeamsTool(
				"list_calendar_time_evidence",
				{ ...ARGS, signal: controller.signal },
				"user-1",
				"org-1",
				"integration-own",
			),
		).rejects.toThrow("deadline");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
