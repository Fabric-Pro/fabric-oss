/**
 * How long background work waits for a ChatGPT plan to reset (Fizzy #2770):
 * until the earliest known reset among the shared accounts serving
 * background work and the member's own plan; half an hour when none is
 * known; not at all when the organization lets the retry run on its own
 * provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	flags: {} as Record<string, boolean>,
	policy: { poolingEnabled: true, apiFallbackBackground: "NEVER" },
	accounts: [] as Array<Record<string, unknown>>,
	states: new Map<string, Date>(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (key: string) => db.flags[key] === true,
	getChatGptPlanOrgPolicy: async () => db.policy,
	listChatGptPlanOrgAccounts: async () => db.accounts,
	getChatGptPlanSourceStates: async (kind: string, ids: string[]) =>
		ids
			.filter((id) => db.states.has(`${kind}:${id}`))
			.map((id) => ({
				sourceId: id,
				openUntil: db.states.get(`${kind}:${id}`),
			})),
}));

import { estimatePlanPoolResetActivity } from "../chatgpt-plan-wait";

const MINUTE = 60_000;
const account = (id: string, overrides = {}) => ({
	id,
	enabled: true,
	status: "ACTIVE",
	serveBackground: true,
	...overrides,
});

beforeEach(() => {
	db.flags = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true };
	db.policy = { poolingEnabled: true, apiFallbackBackground: "NEVER" };
	db.accounts = [account("acc-1"), account("acc-2")];
	db.states = new Map();
});

describe("estimatePlanPoolResetActivity", () => {
	it("waits until the earliest reset among the accounts serving background work", async () => {
		db.states.set("ORG:acc-1", new Date(Date.now() + 90 * MINUTE));
		db.states.set("ORG:acc-2", new Date(Date.now() + 40 * MINUTE));
		const { waitMs, jitterMs } = await estimatePlanPoolResetActivity({
			organizationId: "org-1",
		});
		expect(waitMs).toBeGreaterThan(39 * MINUTE);
		expect(waitMs).toBeLessThanOrEqual(40 * MINUTE);
		expect(jitterMs).toBeGreaterThanOrEqual(0);
		expect(jitterMs).toBeLessThan(5 * MINUTE);
	});

	it("ignores accounts that do not serve background work", async () => {
		db.accounts = [
			account("acc-1", { serveBackground: false }),
			account("acc-2"),
		];
		db.states.set("ORG:acc-1", new Date(Date.now() + 5 * MINUTE));
		db.states.set("ORG:acc-2", new Date(Date.now() + 60 * MINUTE));
		const { waitMs } = await estimatePlanPoolResetActivity({
			organizationId: "org-1",
		});
		expect(waitMs).toBeGreaterThan(59 * MINUTE);
	});

	it("counts the member's own plan too", async () => {
		db.flags = {};
		db.states.set("USER:user-1", new Date(Date.now() + 20 * MINUTE));
		const { waitMs } = await estimatePlanPoolResetActivity({
			organizationId: "org-1",
			userId: "user-1",
		});
		expect(waitMs).toBeGreaterThan(19 * MINUTE);
		expect(waitMs).toBeLessThanOrEqual(20 * MINUTE);
	});

	it("waits half an hour when no reset is known", async () => {
		await expect(
			estimatePlanPoolResetActivity({ organizationId: "org-1" }),
		).resolves.toMatchObject({ waitMs: 30 * MINUTE });
	});

	it("does not wait when the organization lets background work use its provider", async () => {
		db.policy = { poolingEnabled: true, apiFallbackBackground: "AUTO" };
		db.states.set("ORG:acc-1", new Date(Date.now() + 90 * MINUTE));
		await expect(
			estimatePlanPoolResetActivity({ organizationId: "org-1" }),
		).resolves.toEqual({ waitMs: 0, jitterMs: 0 });
	});
});
