import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn() }));

vi.mock("@repo/api/modules/dashboard/lib/curated-feedback-commands", () => ({
	listCuratedFeedbackCommand: m.list,
	recordCuratedFeedbackCommand: m.record,
}));

import { createDashboardTools } from "../tools/dashboard-tools";

const session = {
	organizationId: "org-1",
	userId: "user-1",
	credential: "session",
	scopes: [],
} as unknown as GatewaySession;

beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue({ preferences: [] });
	m.record.mockResolvedValue({ preference: { cardKey: "review:run-1" } });
});

describe("dashboard MCP tools", () => {
	it("lists and records feedback for the session actor", async () => {
		const tools = createDashboardTools();
		await tools.handlers.get("fabric_list_curated_feedback")?.({}, session);
		expect(m.list).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		await tools.handlers.get("fabric_record_curated_feedback")?.(
			{ cardKey: "review:run-1", action: "pin" },
			session,
		);
		expect(m.record).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			{ cardKey: "review:run-1", action: "pin" },
		);
	});

	it("refuses a credential without the declared scope", async () => {
		const tools = createDashboardTools();
		const result = await tools.handlers.get(
			"fabric_record_curated_feedback",
		)?.(
			{ cardKey: "review:run-1", action: "pin" },
			{ ...session, credential: "api_key", scopes: ["projects:read"] },
		);
		expect(result?.isError).toBe(true);
		expect(m.record).not.toHaveBeenCalled();
	});
});
