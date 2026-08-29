/**
 * Unit tests for `newsletter.sends.chatDeliveries` (Fizzy #2013 Task 4).
 *
 * Fully offline — mirrors the harness in sends-approve.test.ts: `@repo/database`
 * and `../../../../orpc/procedures` are mocked, and the procedure's `.handler`
 * is invoked directly via the chainable-proxy `_handler`.
 *
 * `describeChatDeliveryFailure` is deliberately NOT mocked: the point of this
 * procedure is that raw provider text is translated before it crosses the wire,
 * so the real mapper runs and the assertions check the actual output.
 *
 * The `listChatDeliveriesForProjectSend` mock is a fake table that filters on
 * BOTH `sendId` and `projectId`. A handler that dropped the `projectId` bound
 * would still satisfy a naive `mockResolvedValue`, so the fake is what makes
 * the cross-tenant test meaningful.
 *
 * Coverage:
 *  - a send id belonging to a different project returns nothing (the projectId
 *    bound is enforced), and the ledger is queried with the caller's projectId.
 *  - a FAILED Slack row is returned with mapped, actionable copy and the raw
 *    provider code never appears anywhere in the response.
 *  - channelId resolves to the linked channel's display name, and falls back to
 *    the raw channel id when the channel is no longer linked.
 *  - a SENT row carries `reason: null`.
 *
 * Run with: pnpm --filter @repo/api test sends-chat-deliveries
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockListChatDeliveriesForProjectSend,
	mockGetLinkedChannelNames,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockListChatDeliveriesForProjectSend: vi.fn(),
	mockGetLinkedChannelNames: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
	},
	listChatDeliveriesForProjectSend: mockListChatDeliveriesForProjectSend,
	getLinkedChannelNames: mockGetLinkedChannelNames,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		// Org-membership gate on the INPUT organizationId. Real behaviour lives in
		// require-permission.ts and is enforced repo-wide by the SOC 2 ratchet
		// (input-org-unverified-ratchet.test.ts); stubbed here at this unit's
		// boundary like the other middlewares.
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { chatDeliveriesProcedure } from "../sends-chat-deliveries";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const chatDeliveries = (
	chatDeliveriesProcedure as unknown as { _handler: Handler }
)._handler;

type Delivery = {
	kind: string;
	platform: string;
	externalTeamId: string;
	channelId: string;
	channelName: string;
	status: string;
	reason: string | null;
};

const orgContext = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: { activeOrganizationId: "org-1" },
};

const DELIVERED_AT = new Date("2026-08-01T09:00:00.000Z");

/**
 * Two projects' ledgers in one table. `p2`'s rows exist purely so a leak is
 * observable: they must never surface for a `p1` caller.
 */
const LEDGER_ROWS = [
	{
		sendId: "send-1",
		projectId: "p1",
		platform: "SLACK",
		externalTeamId: "T-EXAMPLE",
		channelId: "C-LINKED",
		status: "FAILED",
		errorMessage: "not_in_channel",
		deliveredAt: null as Date | null,
	},
	{
		sendId: "send-1",
		projectId: "p1",
		platform: "TEAMS",
		externalTeamId: "00000000-0000-0000-0000-000000000000",
		channelId: "19:unlinked-channel",
		status: "SENT",
		errorMessage: null as string | null,
		deliveredAt: DELIVERED_AT,
	},
	{
		sendId: "send-other",
		projectId: "p2",
		platform: "SLACK",
		externalTeamId: "T-OTHER",
		channelId: "C-OTHER-TENANT",
		status: "SENT",
		errorMessage: null as string | null,
		deliveredAt: DELIVERED_AT,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
	});
	// Fake table. An unbounded call — one where the handler dropped `projectId`
	// — degrades to the activity-facing behaviour: EVERY project's rows for that
	// send id. That is precisely the leak the bound exists to prevent, so the
	// cross-tenant test below observably fails if the bound is ever removed.
	mockListChatDeliveriesForProjectSend.mockImplementation(
		async (sendId: string, projectId?: string) =>
			LEDGER_ROWS.filter(
				(r) =>
					r.sendId === sendId &&
					(projectId === undefined || r.projectId === projectId),
			).map(({ sendId: _s, projectId: _p, ...rest }) => rest),
	);
	mockGetLinkedChannelNames.mockResolvedValue(
		new Map([["SLACK:T-EXAMPLE:C-LINKED", "release-notes"]]),
	);
});

describe("newsletter.sends.chatDeliveries", () => {
	it("does not return another project's ledger rows for a foreign send id", async () => {
		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-other",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		expect(result).toEqual({ deliveries: [] });
		// The bound is what makes this safe: an unbounded read of "send-other"
		// would hand p1 a row belonging to p2.
		expect(mockListChatDeliveriesForProjectSend).toHaveBeenCalledWith(
			"send-other",
			"p1",
		);
		expect(JSON.stringify(result)).not.toContain("C-OTHER-TENANT");
		// Nothing to name — the linked-channel lookup is skipped entirely.
		expect(mockGetLinkedChannelNames).not.toHaveBeenCalled();
	});

	it("a project id that resolves to no row -> NOT_FOUND before the ledger is read", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await chatDeliveries({
			input: {
				projectId: "other-tenant",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockListChatDeliveriesForProjectSend).not.toHaveBeenCalled();
	});

	it("maps a FAILED Slack row to actionable copy without echoing the raw provider code", async () => {
		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		const slack = result.deliveries.find((d) => d.platform === "SLACK");
		expect(slack?.status).toBe("FAILED");
		expect(slack?.reason).toBe(
			"Fabric is not a member of this Slack channel. Invite the app to the channel, then send again.",
		);
		// The raw code is engineer-facing and stays in the DB and the worker
		// logs; a read-only viewer must never receive it.
		expect(JSON.stringify(result)).not.toContain("not_in_channel");
	});

	it("resolves a linked channel's display name and falls back to the raw id when it is no longer linked", async () => {
		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		const slack = result.deliveries.find((d) => d.platform === "SLACK");
		const teams = result.deliveries.find((d) => d.platform === "TEAMS");

		expect(slack?.channelName).toBe("release-notes");
		// The Teams row's channel was unlinked after the send: it stays in the
		// list under its raw id rather than disappearing.
		expect(teams?.channelName).toBe("19:unlinked-channel");
		expect(teams?.channelId).toBe("19:unlinked-channel");
	});

	it("reports no reason for a confirmed delivery", async () => {
		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		const teams = result.deliveries.find((d) => d.platform === "TEAMS");
		expect(teams?.status).toBe("SENT");
		expect(teams?.reason).toBeNull();
	});

	it("returns externalTeamId so the client can build a collision-free row key", async () => {
		// The ledger's identity is (platform, externalTeamId, channelId) — a
		// channel id is unique only WITHIN a workspace/team. Without the team id
		// the panel would key on platform+channelId and silently drop a row when
		// the same channel id appears under two connected workspaces.
		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		const keys = result.deliveries.map(
			(d) => `${d.platform}:${d.externalTeamId}:${d.channelId}`,
		);
		expect(keys).toEqual([
			"SLACK:T-EXAMPLE:C-LINKED",
			"TEAMS:00000000-0000-0000-0000-000000000000:19:unlinked-channel",
		]);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("returns the delivery kind so the client can tell an alert from a delivery", async () => {
		// Fake table holds one CONTENT and one APPROVAL row for ONE channel
		// tuple — the shape produced once an alerted channel also receives the
		// approved notes. Two DIFFERENT channels would pass whether or not
		// `kind` is projected at all, and would prove nothing.
		mockListChatDeliveriesForProjectSend.mockResolvedValueOnce([
			{
				kind: "APPROVAL",
				platform: "SLACK",
				externalTeamId: "T-EXAMPLE",
				channelId: "C-LINKED",
				status: "SENT",
				errorMessage: null as string | null,
			},
			{
				kind: "CONTENT",
				platform: "SLACK",
				externalTeamId: "T-EXAMPLE",
				channelId: "C-LINKED",
				status: "SENT",
				errorMessage: null as string | null,
			},
		]);

		const result = (await chatDeliveries({
			input: {
				projectId: "p1",
				organizationId: "org-1",
				sendId: "send-1",
			},
			context: orgContext,
		})) as { deliveries: Delivery[] };

		expect(result.deliveries).toHaveLength(2);
		expect(result.deliveries.map((d) => d.kind).sort()).toEqual([
			"APPROVAL",
			"CONTENT",
		]);
	});
});
