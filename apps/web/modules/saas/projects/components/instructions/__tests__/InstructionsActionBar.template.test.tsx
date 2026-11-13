/**
 * "Add files from the organization template" under the tab's More menu: there
 * only when the tab offers it, paused like Add file while a move into a
 * repository is open, and busy while a copy is running.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import {
	InstructionsActionBar,
	type InstructionsActions,
} from "../InstructionsActionBar";

const LABEL = "Add files from the organization template";
const REASON =
	"Moving to example-org/instructions: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.";

function actions(
	overrides: Partial<InstructionsActions> = {},
): InstructionsActions {
	return {
		history: { onOpen: vi.fn() },
		settings: { onOpen: vi.fn() },
		...overrides,
	};
}

beforeEach(() => {
	toastInfo.mockReset();
});

describe("InstructionsActionBar — the organization template", () => {
	it("runs the template action from the More menu", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					applyTemplate: { pending: false, onApply },
				})}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(await screen.findByRole("menuitem", { name: LABEL }));

		expect(onApply).toHaveBeenCalledTimes(1);
		expect(toastInfo).not.toHaveBeenCalled();
	});

	it("keeps the action but disabled while changes are paused, and says why", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					applyTemplate: {
						pending: false,
						onApply,
						pausedReason: REASON,
					},
				})}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "More" }));
		const item = await screen.findByRole("menuitem", { name: LABEL });
		await user.click(item);

		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(onApply).not.toHaveBeenCalled();
		expect(toastInfo).toHaveBeenCalledWith(REASON);
	});

	it("cannot be run twice while a copy is in progress", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					applyTemplate: { pending: true, onApply },
				})}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "More" }));
		const item = await screen.findByRole("menuitem", { name: LABEL });

		expect(item).toHaveAttribute("data-disabled");
		expect(onApply).not.toHaveBeenCalled();
	});

	it("is absent when the tab does not offer it", async () => {
		const user = userEvent.setup();
		render(<InstructionsActionBar actions={actions()} />);

		await user.click(screen.getByRole("button", { name: "More" }));
		await screen.findByRole("menuitem", { name: "Settings" });

		expect(
			screen.queryByRole("menuitem", { name: LABEL }),
		).not.toBeInTheDocument();
	});
});
