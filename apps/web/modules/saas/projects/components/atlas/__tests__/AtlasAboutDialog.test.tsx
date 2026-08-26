/**
 * Behaviour tests for the "About Atlas" info dialog.
 *
 * A self-contained `(i)` trigger + Dialog that explains the Atlas FEATURE
 * (Analyse · Map · Explore · Ask), not the analysed repo. next-intl is globally
 * key-mocked in vitest.setup.ts, so translated strings surface as their keys:
 * the trigger is queried by its aria-label key "triggerLabel" and the card
 * content by the echoed step / footer keys.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import { AtlasAboutDialog } from "../AtlasAboutDialog";

expect.extend(axeMatchers);

describe("AtlasAboutDialog", () => {
	it("renders a labelled (i) trigger and stays closed until activated", () => {
		render(<AtlasAboutDialog />);

		expect(
			screen.getByRole("button", { name: "triggerLabel" }),
		).toBeInTheDocument();
		// Closed: the card content is not mounted yet.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.queryByText("askTitle")).not.toBeInTheDocument();
	});

	it("opens the about card with the title, all four stages and the drift callout", async () => {
		const user = userEvent.setup();
		render(<AtlasAboutDialog />);

		await user.click(screen.getByRole("button", { name: "triggerLabel" }));

		const dialog = await screen.findByRole("dialog");
		// The serif DialogTitle wires the dialog's accessible name.
		expect(dialog).toHaveAccessibleName();
		expect(screen.getByText("label")).toBeInTheDocument();
		expect(screen.getByText("title")).toBeInTheDocument();
		// All four stages, each numbered.
		for (const step of [
			"analyseTitle",
			"mapTitle",
			"exploreTitle",
			"askTitle",
		]) {
			expect(screen.getByText(step)).toBeInTheDocument();
		}
		for (const n of ["01", "02", "03", "04"]) {
			expect(screen.getByText(n)).toBeInTheDocument();
		}
		// Amber re-analyse callout.
		expect(screen.getByText("footerNote")).toBeInTheDocument();
	});

	it("closes on Escape", async () => {
		const user = userEvent.setup();
		render(<AtlasAboutDialog />);

		await user.click(screen.getByRole("button", { name: "triggerLabel" }));
		await screen.findByRole("dialog");

		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});

	it("has no obvious accessibility violations while open", async () => {
		const user = userEvent.setup();
		render(<AtlasAboutDialog />);

		await user.click(screen.getByRole("button", { name: "triggerLabel" }));
		await screen.findByRole("dialog");

		expect(await axe(document.body)).toHaveNoViolations();
	});
});
