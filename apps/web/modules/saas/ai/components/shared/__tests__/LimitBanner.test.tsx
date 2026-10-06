/**
 * An `internal_budget` stop is either the per-run token budget or the
 * per-run iteration limit. The banner used to call both a token budget and
 * offer Billing settings for both (Fizzy #2944).
 */
import type { LimitSignal } from "@repo/ai/limits";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LimitBanner } from "../LimitBanner";

const BUDGET = { used: 206_782, total: 500_000, usagePercentage: 0.413564 };

describe("LimitBanner internal_budget copy", () => {
	it("names an iteration-limit stop as a step limit, without the billing link", () => {
		const signal: LimitSignal = {
			kind: "internal_budget",
			message: "Iteration limit reached: 14/15",
			budget: BUDGET,
			budgetLimit: "iterations",
		};
		render(<LimitBanner signal={signal} canManageBilling />);

		expect(
			screen.getByText("Response was cut short — step limit reached"),
		).toBeTruthy();
		expect(screen.queryByText(/tokens/)).toBeNull();
		expect(
			screen.queryByRole("link", { name: /Billing settings/ }),
		).toBeNull();
	});

	it("names a token stop as a token budget, with the usage as a whole percent", () => {
		const signal: LimitSignal = {
			kind: "internal_budget",
			message: "Token budget exceeded: 492001/500000",
			budget: BUDGET,
			budgetLimit: "tokens",
		};
		render(<LimitBanner signal={signal} canManageBilling />);

		expect(
			screen.getByText("Response was cut short — token budget reached"),
		).toBeTruthy();
		expect(
			screen.getByText(/\(206,782 \/ 500,000 tokens, 41%\)/),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /Billing settings/ }),
		).toBeTruthy();
	});

	it("reads a signal recorded before budgetLimit existed as a token stop", () => {
		const signal: LimitSignal = {
			kind: "internal_budget",
			message: "Token budget exceeded: 492001/500000",
			budget: BUDGET,
		};
		render(<LimitBanner signal={signal} />);

		expect(
			screen.getByText("Response was cut short — token budget reached"),
		).toBeTruthy();
	});
});
