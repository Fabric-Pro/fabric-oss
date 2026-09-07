/**
 * The reachability preflight's three-way outcome (Fizzy #2355).
 *
 * The whole reason this file exists is that "we could not check" and "you cannot
 * see it" lead to opposite recommendations, and the meeting preflight shipped
 * once with them collapsed: it reported every meeting as invisible and then
 * refused the repair it had just made look pointless. These tests pin the split
 * so that cannot happen again for the monitors.
 */

import { describe, expect, it, vi } from "vitest";
import {
	assertPreflightAllowsRebind,
	classifyProviderError,
	type MonitorConversation,
	runMonitorPreflight,
} from "../monitor-reconnect";

const conversation = (id: string): MonitorConversation => ({
	id,
	label: `#${id}`,
});

describe("classifyProviderError", () => {
	it.each([
		"Slack API conversations.history error: ratelimited",
		"Graph request failed: 429 Too Many Requests",
		"upstream returned 503 Service Unavailable",
		"socket hang up: ETIMEDOUT",
	])("treats %s as indeterminate", (message) => {
		expect(classifyProviderError(message)).toBe("indeterminate");
	});

	it.each([
		"Slack API conversations.history error: channel_not_found",
		"Slack API conversations.history error: not_in_channel",
		"Graph error: Forbidden",
	])("treats %s as a verdict about the account", (message) => {
		expect(classifyProviderError(message)).toBe("unreachable");
	});

	it("biases an unrecognised message toward unreachable, not toward silence", () => {
		// Reporting "you cannot see this" is visible and checkable. Reporting
		// "could not check" for a real permission failure would hide it behind
		// a retry that never succeeds.
		expect(classifyProviderError("something nobody anticipated")).toBe(
			"unreachable",
		);
	});
});

describe("runMonitorPreflight", () => {
	it("sorts each conversation into exactly one bucket", async () => {
		const report = await runMonitorPreflight({
			conversations: ["a", "b", "c"].map(conversation),
			probe: async (c) =>
				c.id === "a"
					? "reachable"
					: c.id === "b"
						? "unreachable"
						: "indeterminate",
		});

		expect(report).toEqual({
			total: 3,
			reachableCount: 1,
			unreachableLabels: ["#b"],
			indeterminateLabels: ["#c"],
		});
	});

	it("counts a thrown probe as indeterminate, never as unreachable", async () => {
		const report = await runMonitorPreflight({
			conversations: [conversation("a")],
			probe: async () => {
				throw new Error("network died");
			},
		});

		expect(report.indeterminateLabels).toEqual(["#a"]);
		expect(report.unreachableLabels).toEqual([]);
	});

	it("caps the number of probes so a large project cannot hit the rate limit", async () => {
		const probe = vi.fn(async () => "reachable" as const);
		const report = await runMonitorPreflight({
			conversations: Array.from({ length: 40 }, (_, i) =>
				conversation(String(i)),
			),
			probe,
		});

		expect(probe).toHaveBeenCalledTimes(25);
		expect(report.total).toBe(25);
	});

	it("probes in sequence, because the cap exists to respect a rate limit", async () => {
		let concurrent = 0;
		let peak = 0;
		await runMonitorPreflight({
			conversations: ["a", "b", "c"].map(conversation),
			probe: async () => {
				concurrent++;
				peak = Math.max(peak, concurrent);
				await Promise.resolve();
				concurrent--;
				return "reachable";
			},
		});

		expect(peak).toBe(1);
	});
});

describe("assertPreflightAllowsRebind", () => {
	it("allows the rebind when anything at all is reachable", () => {
		expect(() =>
			assertPreflightAllowsRebind(
				{
					total: 3,
					reachableCount: 1,
					unreachableLabels: ["#b", "#c"],
					indeterminateLabels: [],
				},
				"channel",
			),
		).not.toThrow();
	});

	it("refuses when the account definitely sees nothing", () => {
		expect(() =>
			assertPreflightAllowsRebind(
				{
					total: 2,
					reachableCount: 0,
					unreachableLabels: ["#a", "#b"],
					indeterminateLabels: [],
				},
				"channel",
			),
		).toThrow(/visible to your account/);
	});

	it("asks for a retry — not a refusal — when nothing could be checked", () => {
		// The distinction this whole module exists for: an unchecked monitor
		// must not be reported as an invisible one.
		expect(() =>
			assertPreflightAllowsRebind(
				{
					total: 2,
					reachableCount: 0,
					unreachableLabels: [],
					indeterminateLabels: ["#a", "#b"],
				},
				"channel",
			),
		).toThrow(/could not check/);
	});

	it("still asks for a retry when some were unreachable and the rest unchecked", () => {
		expect(() =>
			assertPreflightAllowsRebind(
				{
					total: 2,
					reachableCount: 0,
					unreachableLabels: ["#a"],
					indeterminateLabels: ["#b"],
				},
				"channel",
			),
		).toThrow(/could not check/);
	});
});
