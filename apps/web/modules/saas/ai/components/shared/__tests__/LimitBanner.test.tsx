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

// Fizzy #2770: the spent plan may be one the organization shares with a
// member who has no plan of their own, so the copy never says "your own".
describe("LimitBanner subscription_exhausted copy", () => {
	it("names the plan serving the work, not the member's own plan", () => {
		render(
			<LimitBanner
				signal={{
					kind: "subscription_exhausted",
					message:
						"Every ChatGPT plan this work may use has no usage left",
					retryAfterMs: 30 * 60_000,
				}}
			/>,
		);
		const banner = screen.getByRole("alert");
		expect(banner).toHaveTextContent("The ChatGPT plan has no usage left");
		expect(banner).toHaveTextContent(
			"The ChatGPT plan serving your work reached its usage limit",
		);
		expect(banner).not.toHaveTextContent(/your own ChatGPT plan reached/i);
	});
});
