/**
 * Start swaps for "Timer running" when a timer starts, and back when it
 * ends. Keyboard focus follows the swap instead of falling to the page body,
 * and focus that moved somewhere else is left there.
 */

import type { TimerStartValues } from "@saas/time-tracking/hooks/use-timer";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

interface FakeTimer {
	projectId: string;
	storyId: string | null;
	status: "RUNNING" | "PAUSED";
}

const timerState = vi.hoisted(() => {
	const state: { timer: FakeTimer | null; start: Mock } = {
		timer: null,
		start: vi.fn(),
	};
	return state;
});

vi.mock("@saas/time-tracking/hooks/use-timer", () => ({
	requestTimerOpen: vi.fn(),
	useTimer: () => ({ timer: timerState.timer }),
	useTimerActions: () => ({
		isStarting: false,
		start: timerState.start,
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import { StartTimerButton } from "@saas/time-tracking/components/StartTimerButton";
import { requestTimerOpen } from "@saas/time-tracking/hooks/use-timer";

const values: TimerStartValues = {
	projectId: "project-a",
	activity: "DEVELOPMENT",
	story: null,
};
const running: FakeTimer = {
	projectId: "project-a",
	storyId: null,
	status: "RUNNING",
};

function renderButton() {
	return render(
		<>
			<StartTimerButton organizationId="org-1" values={values} />
			<input aria-label="elsewhere" />
		</>,
	);
}

beforeEach(() => {
	timerState.timer = null;
	timerState.start.mockReset();
	timerState.start.mockImplementation(async () => {
		timerState.timer = running;
		return true;
	});
});

describe("StartTimerButton", () => {
	it("hands focus to Timer running after Start is pressed from the keyboard", async () => {
		const user = userEvent.setup();
		const view = renderButton();

		screen.getByRole("button", { name: /start/ }).focus();
		await user.keyboard("{Enter}");
		expect(timerState.start).toHaveBeenCalledWith(values);
		view.rerender(
			<>
				<StartTimerButton organizationId="org-1" values={values} />
				<input aria-label="elsewhere" />
			</>,
		);

		expect(
			screen.getByRole("button", { name: /runningButton/ }),
		).toHaveFocus();
	});

	it("hands focus back to Start when the timer it held focus for ends", () => {
		timerState.timer = running;
		const view = renderButton();

		screen.getByRole("button", { name: /runningButton/ }).focus();
		timerState.timer = null;
		view.rerender(
			<>
				<StartTimerButton organizationId="org-1" values={values} />
				<input aria-label="elsewhere" />
			</>,
		);

		expect(screen.getByRole("button", { name: /start/ })).toHaveFocus();
	});

	it("leaves focus where it moved when the timer changes", () => {
		timerState.timer = running;
		const view = renderButton();

		screen.getByRole("button", { name: /runningButton/ }).focus();
		screen.getByRole("textbox", { name: "elsewhere" }).focus();
		timerState.timer = null;
		view.rerender(
			<>
				<StartTimerButton organizationId="org-1" values={values} />
				<input aria-label="elsewhere" />
			</>,
		);

		expect(
			screen.getByRole("textbox", { name: "elsewhere" }),
		).toHaveFocus();
	});

	it("returns focus to Timer running when its menu is closed with Escape", async () => {
		timerState.timer = running;
		const user = userEvent.setup();
		renderButton();
		const trigger = screen.getByRole("button", { name: /runningButton/ });

		trigger.focus();
		await user.keyboard("{Enter}");
		expect(
			await screen.findByRole("menuitem", { name: "openTimer" }),
		).toBeInTheDocument();
		await user.keyboard("{Escape}");

		expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("leaves focus to the timer panel when Open timer is chosen", async () => {
		timerState.timer = running;
		const user = userEvent.setup();
		renderButton();
		const trigger = screen.getByRole("button", { name: /runningButton/ });

		trigger.focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("menuitem", { name: "openTimer" });
		await user.keyboard("{Enter}");

		expect(requestTimerOpen).toHaveBeenCalledWith();
		expect(trigger).not.toHaveFocus();
	});
});
