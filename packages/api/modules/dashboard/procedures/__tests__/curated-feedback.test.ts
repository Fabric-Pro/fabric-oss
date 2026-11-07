import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn() }));

vi.mock("@repo/database", () => ({
	DASHBOARD_CURATED_FEEDBACK_ACTIONS: [
		"click",
		"pin",
		"unpin",
		"dismiss",
		"restore",
	],
	listDashboardCuratedFeedback: m.list,
	recordDashboardCuratedFeedback: m.record,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => ({
			...chain,
			handler: (handler: unknown) => handler,
		}),
		handler: (handler: unknown) => handler,
	};
	return {
		Permissions: new Proxy({}, { get: (_target, property) => property }),
		requireInputOrgPermission: vi.fn(),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		tenantProtectedProcedure: chain,
	};
});

import { getDashboardCuratedFeedback } from "../get-curated-feedback";
import { recordDashboardCuratedFeedback } from "../record-curated-feedback";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("dashboard curated feedback procedures", () => {
	it("reads preferences for the authenticated user and resolved organization", async () => {
		await (
			getDashboardCuratedFeedback as unknown as (
				args: unknown,
			) => Promise<unknown>
		)({
			input: { organizationId: "org-1" },
			context: { user: { id: "user-1" }, session: {} },
		});
		expect(m.list).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("records the stable card key for the same actor", async () => {
		await (
			recordDashboardCuratedFeedback as unknown as (
				args: unknown,
			) => Promise<unknown>
		)({
			input: {
				organizationId: "org-1",
				cardKey: "review:run-1",
				action: "pin",
			},
			context: { user: { id: "user-1" }, session: {} },
		});
		expect(m.record).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			cardKey: "review:run-1",
			action: "pin",
		});
	});
});
