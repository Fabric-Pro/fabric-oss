/**
 * The shared accounts' windows the picker reads on every pooled call are
 * reused by a process for 30 s (Fizzy #2770): per organization and account
 * set, re-read after that, and a failed read is never reused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const windows = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({
	getChatGptPlanOrgAccountWindows: windows,
}));

import {
	__resetChatGptPlanWindowCache,
	getCachedChatGptPlanOrgAccountWindows,
} from "../lib/chatgpt-plan/window-cache";

const T0 = Date.parse("2026-10-08T12:00:00Z");

beforeEach(() => {
	__resetChatGptPlanWindowCache();
	windows.mockReset();
	windows.mockResolvedValue(new Map());
});

describe("getCachedChatGptPlanOrgAccountWindows", () => {
	it("reuses an organization's windows for 30 s, whatever the account order", async () => {
		await getCachedChatGptPlanOrgAccountWindows(
			"org_a",
			["acc_1", "acc_2"],
			T0,
		);
		await getCachedChatGptPlanOrgAccountWindows(
			"org_a",
			["acc_2", "acc_1"],
			T0 + 29_000,
		);
		expect(windows).toHaveBeenCalledTimes(1);
		await getCachedChatGptPlanOrgAccountWindows(
			"org_a",
			["acc_1", "acc_2"],
			T0 + 31_000,
		);
		expect(windows).toHaveBeenCalledTimes(2);
	});

	it("never shares windows across organizations or account sets", async () => {
		await getCachedChatGptPlanOrgAccountWindows("org_a", ["acc_1"], T0);
		await getCachedChatGptPlanOrgAccountWindows("org_b", ["acc_1"], T0);
		await getCachedChatGptPlanOrgAccountWindows(
			"org_a",
			["acc_1", "acc_2"],
			T0,
		);
		expect(windows).toHaveBeenCalledTimes(3);
		expect(
			windows.mock.calls.map((call) => call[0].organizationId),
		).toEqual(["org_a", "org_b", "org_a"]);
	});

	it("does not reuse a failed read", async () => {
		windows.mockRejectedValueOnce(new Error("database down"));
		await expect(
			getCachedChatGptPlanOrgAccountWindows("org_a", ["acc_1"], T0),
		).rejects.toThrow("database down");
		await getCachedChatGptPlanOrgAccountWindows("org_a", ["acc_1"], T0 + 1);
		expect(windows).toHaveBeenCalledTimes(2);
	});
});
