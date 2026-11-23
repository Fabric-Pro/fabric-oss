import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: async (
		...args: Parameters<
			typeof import("@repo/database/prisma/queries/workflows/integration-access").resolveWorkflowIntegrationForProvider
		>
	) => {
		const mocked = await import("@repo/database");
		return mocked.db.workflowIntegration.findFirst({
			where: {
				...mocked.workflowIntegrationAccessWhere(args[1], args[2]),
				provider: args[0],
				isActive: true,
			},
		});
	},
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

import { executeMicrosoftTeamsTool } from "../index";

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example-series";

describe("executeMicrosoftTeamsTool('list_calendar_meetings')", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({ access_token: "graph-test-token" }),
			settings: { email: "dev@example.com", name: "Dev Example" },
		});
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "event-1",
						subject: "Weekly sync",
						start: {
							dateTime: "2026-10-27T09:00:00.0000000",
							timeZone: "UTC",
						},
						isOnlineMeeting: true,
						onlineMeeting: { joinUrl: JOIN_URL },
						isCancelled: true,
					},
					{
						id: "event-2",
						subject: "Weekly sync",
						start: {
							dateTime: "2026-11-03T09:00:00.0000000",
							timeZone: "UTC",
						},
						isOnlineMeeting: true,
						onlineMeeting: { joinUrl: JOIN_URL },
					},
				],
			}),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("asks Graph whether each occurrence is cancelled and says so on every meeting", async () => {
		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{
				startDate: "2026-10-27T00:00:00.000Z",
				endDate: "2026-11-04T00:00:00.000Z",
			},
			"user-1",
			"org-1",
		)) as { meetings: Array<{ id: string; isCancelled: boolean }> };

		const [url] = fetchMock.mock.calls[0] as [string];
		expect(new URL(url).searchParams.get("$select")?.split(",")).toContain(
			"isCancelled",
		);
		expect(
			result.meetings.map(({ id, isCancelled }) => ({ id, isCancelled })),
		).toEqual([
			{ id: "event-1", isCancelled: true },
			{ id: "event-2", isCancelled: false },
		]);
	});

	const planning = {
		ok: true,
		status: 200,
		headers: new Headers(),
		json: async () => ({
			value: [
				{
					id: "event-3",
					subject: "Planning",
					start: {
						dateTime: "2026-10-27T09:00:00.0000000",
						timeZone: "UTC",
					},
					isOnlineMeeting: true,
					onlineMeeting: { joinUrl: JOIN_URL },
					organizer: {
						emailAddress: { address: "dev@example.com" },
					},
					attendees: [
						{
							type: "required",
							emailAddress: {
								address: "Pat@Partner.example",
							},
						},
						{
							type: "optional",
							emailAddress: {
								address: "Dev.Two@Example.com",
							},
						},
						{
							type: "resource",
							emailAddress: { address: "room@example.com" },
						},
					],
				},
			],
		}),
	};

	it("gives the invitees' email domains, never their addresses, and leaves rooms out", async () => {
		fetchMock.mockResolvedValue(planning);

		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{
				startDate: "2026-10-27T00:00:00.000Z",
				endDate: "2026-10-28T00:00:00.000Z",
			},
			"user-1",
			"org-1",
		)) as { meetings: Array<{ attendeeDomains: string[] }> };

		const [url] = fetchMock.mock.calls[0] as [string];
		expect(new URL(url).searchParams.get("$select")?.split(",")).toContain(
			"attendees",
		);
		expect(result.meetings[0]?.attendeeDomains).toEqual([
			"example.com",
			"partner.example",
		]);
		expect(JSON.stringify(result)).not.toContain("Pat@");
		expect(result.meetings[0]).not.toHaveProperty("inviteeEmails");
	});

	it("gives the addresses of the invitees from the domain asked for, and no one else's", async () => {
		fetchMock.mockResolvedValue(planning);

		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{
				startDate: "2026-10-27T00:00:00.000Z",
				endDate: "2026-10-28T00:00:00.000Z",
			},
			"user-1",
			"org-1",
			undefined,
			{ inviteeEmailDomain: "Example.com" },
		)) as { meetings: Array<{ inviteeEmails: string[] }> };

		expect(result.meetings[0]?.inviteeEmails).toEqual([
			"dev@example.com",
			"dev.two@example.com",
		]);
		expect(JSON.stringify(result).toLowerCase()).not.toContain("pat@");
		expect(JSON.stringify(result)).not.toContain("room@");
	});

	it("gives no address to a tool call that asks for a domain in its arguments", async () => {
		fetchMock.mockResolvedValue(planning);

		const result = (await executeMicrosoftTeamsTool(
			"list_calendar_meetings",
			{
				startDate: "2026-10-27T00:00:00.000Z",
				endDate: "2026-10-28T00:00:00.000Z",
				inviteeEmailDomain: "example.com",
			},
			"user-1",
			"org-1",
		)) as { meetings: Array<Record<string, unknown>> };

		expect(result.meetings[0]).not.toHaveProperty("inviteeEmails");
		expect(JSON.stringify(result)).not.toContain("dev.two@example.com");
	});
});
