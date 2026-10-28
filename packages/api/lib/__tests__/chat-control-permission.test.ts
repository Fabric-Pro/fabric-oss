import { expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { member: { findFirst: async () => ({ role: "viewer" }) } },
	hasOrganizationTie: async () => true,
	hasProjectAccess: async () => true,
}));

import { canControlChatRun } from "../chat-control-permission";

it.each(["approve", "cancel", "observe"] as const)(
	"allows a viewer who owns a run to %s",
	async (action) => {
		expect(
			await canControlChatRun({
				userId: "example-user",
				organizationId: "example-org",
				action,
			}),
		).toBe(true);
	},
);
