/**
 * First-login welcome dialog — the two actions must stay strictly separate.
 *
 * The component is presentational; the controller owns what each action does.
 * What matters here is that neither action can trigger the other, and that the
 * incidental closes (Escape, outside click) resolve to declining rather than
 * starting a tour the user never asked for.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetStartedWelcomeDialog } from "../GetStartedWelcomeDialog";

const TITLE = "onboarding.tour.welcome.title";
const BODY = "onboarding.tour.welcome.body";
const START = "onboarding.tour.welcome.start";
const DISMISS = "onboarding.tour.welcome.dismiss";

const onStartTour = vi.fn();
const onDismiss = vi.fn();

function renderDialog() {
	return render(
		<GetStartedWelcomeDialog
			onStartTour={onStartTour}
			onDismiss={onDismiss}
		/>,
	);
}

beforeEach(() => {
	onStartTour.mockReset();
	onDismiss.mockReset();
});

describe("GetStartedWelcomeDialog", () => {
	it("presents the title, body and exactly two actions", async () => {
		renderDialog();

		expect(await screen.findByText(TITLE)).toBeInTheDocument();
		expect(screen.getByText(BODY)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: START })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: DISMISS }),
		).toBeInTheDocument();
	});

	it("starts the tour from the primary action, and only that", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("button", { name: START }));

		expect(onStartTour).toHaveBeenCalledTimes(1);
		expect(onDismiss).not.toHaveBeenCalled();
	});

	it("dismisses from the secondary action without starting the tour", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("button", { name: DISMISS }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onStartTour).not.toHaveBeenCalled();
	});

	it("treats Escape as declining, not as taking the tour", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.keyboard("{Escape}");

		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onStartTour).not.toHaveBeenCalled();
	});

	it("reaches both actions by keyboard", async () => {
		const user = userEvent.setup();
		renderDialog();

		const dismiss = screen.getByRole("button", { name: DISMISS });
		dismiss.focus();
		await user.keyboard("{Enter}");

		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onStartTour).not.toHaveBeenCalled();
	});

	it("holds no user-facing string of its own — every label comes from a key", async () => {
		renderDialog();

		// The global next-intl mock echoes the key, so a hardcoded string would
		// surface here as literal prose rather than a dotted key.
		for (const key of [TITLE, BODY, START, DISMISS]) {
			expect(await screen.findByText(key)).toBeInTheDocument();
		}
	});
});
