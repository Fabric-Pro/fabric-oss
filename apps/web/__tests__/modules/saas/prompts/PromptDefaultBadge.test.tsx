/**
 * What the library tells a user about which prompt actually runs.
 *
 * A bare "Default" was ambiguous once three tiers existed, and "no badge at all"
 * made a prompt bound to the same action as the default look identical to one
 * bound to nothing. FR4 is the tier; FR5 is the availability.
 */

import { PromptDefaultBadge } from "@saas/prompts/components/PromptDefaultBadge";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("PromptDefaultBadge", () => {
	it("names the tier the default came from", () => {
		render(<PromptDefaultBadge isDefault isBound defaultScope="USER" />);
		expect(screen.getByText(/default · personal/i)).toBeInTheDocument();
	});

	it("uses the same tier vocabulary as the binding dialog", () => {
		const { rerender } = render(
			<PromptDefaultBadge isDefault isBound defaultScope="SYSTEM" />,
		);
		expect(screen.getByText(/default · system/i)).toBeInTheDocument();

		rerender(<PromptDefaultBadge isDefault isBound defaultScope="ORG" />);
		expect(screen.getByText(/default · organization/i)).toBeInTheDocument();
	});

	it("colours the badge by the tier in force", () => {
		// Outlined, tier-coloured: scanning the catalog answers both what is in
		// force and how far up the ladder its authority reaches.
		//
		// SYSTEM and ORG read their `-ink` tokens rather than the plain brand
		// colour: the label is ink on the card, and the fill-tuned values measure
		// 4.02:1 (primary, dark) and 3.14:1 (highlight, light) there — under AA.
		const expectations = [
			["SYSTEM", "text-primary-ink"],
			["ORG", "text-highlight-ink"],
			["PROJECT", "text-blue-600"],
			["USER", "text-success"],
		] as const;
		for (const [scope, colorClass] of expectations) {
			const { container } = render(
				<PromptDefaultBadge isDefault isBound defaultScope={scope} />,
			);
			expect(container.firstElementChild).toHaveClass(colorClass);
		}
	});

	it("keeps an unknown-tier Default neutral", () => {
		render(<PromptDefaultBadge isDefault isBound />);
		expect(screen.getByText(/default/i)).not.toHaveClass(
			"text-primary",
			"text-success",
		);
	});

	it("marks a bound non-default prompt as available", () => {
		render(<PromptDefaultBadge isBound />);
		expect(screen.getByText(/available/i)).toBeInTheDocument();
		expect(screen.queryByText(/default/i)).not.toBeInTheDocument();
	});

	it("renders nothing for a prompt bound to nothing", () => {
		const { container } = render(<PromptDefaultBadge />);
		expect(container).toBeEmptyDOMElement();
	});

	it("falls back to a bare Default when the tier is unknown", () => {
		// Older callers that have not been passed a scope should still render
		// something truthful rather than "Default · undefined".
		render(<PromptDefaultBadge isDefault isBound />);
		const badge = screen.getByText(/default/i);
		expect(badge).toBeInTheDocument();
		expect(badge.textContent).not.toMatch(/undefined|null|·/i);
	});
});
