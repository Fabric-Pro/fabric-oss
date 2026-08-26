/**
 * The banner's buttons are a real form submit posting to `/api/consent`.
 *
 * That is the safety net for the case the client bundle never hydrates: the
 * handlers are then never attached, and a plain React `onClick` banner becomes
 * permanently undismissable while CSS hover and focus still work — which is
 * exactly what a stuck consent prompt looks like to the person in front of it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConsentBanner } from "./ConsentBanner";

function getForm() {
	return screen.getByRole("form", { name: "Analytics consent options" });
}

describe("ConsentBanner", () => {
	it("submits the decision to the server route when scripting is unavailable", () => {
		render(
			<ConsentBanner
				onAllowAnalytics={vi.fn()}
				onDecline={vi.fn()}
				returnTo="/docs"
			/>,
		);

		const form = getForm() as HTMLFormElement;
		expect(form.getAttribute("action")).toBe("/api/consent");
		expect(form.getAttribute("method")).toBe("post");
		expect(form.querySelector('input[name="returnTo"]')).toHaveValue(
			"/docs",
		);

		const allow = screen.getByRole("button", { name: "Allow analytics" });
		const decline = screen.getByRole("button", { name: "Decline" });
		expect(allow).toHaveAttribute("type", "submit");
		expect(allow).toHaveAttribute("name", "decision");
		expect(allow).toHaveAttribute("value", "analytics");
		expect(decline).toHaveAttribute("type", "submit");
		expect(decline).toHaveAttribute("name", "decision");
		expect(decline).toHaveAttribute("value", "decline");
	});

	it("handles the click in the client and cancels the native submit", () => {
		const onAllowAnalytics = vi.fn();
		const onDecline = vi.fn();
		render(
			<ConsentBanner
				onAllowAnalytics={onAllowAnalytics}
				onDecline={onDecline}
			/>,
		);

		// fireEvent returns false when the handler called preventDefault, which
		// is what keeps a hydrated page from doing a full-page form navigation.
		expect(
			fireEvent.click(
				screen.getByRole("button", { name: "Allow analytics" }),
			),
		).toBe(false);
		expect(onAllowAnalytics).toHaveBeenCalledTimes(1);

		expect(
			fireEvent.click(screen.getByRole("button", { name: "Decline" })),
		).toBe(false);
		expect(onDecline).toHaveBeenCalledTimes(1);
	});
});
