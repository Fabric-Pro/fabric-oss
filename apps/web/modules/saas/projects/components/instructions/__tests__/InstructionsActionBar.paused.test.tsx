/**
 * The tab's actions while the project's uploaded instructions are being moved
 * into a repository (Fizzy #2878 §9): Upload folder or Upload new version and
 * Add file stay where they are but are disabled, and pressing one says why
 * instead of opening a dialog the server would refuse.
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

describe("InstructionsActionBar while a move into a repository is open", () => {
	it("keeps Upload new version but disabled, and says why when it is pressed", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					upload: { published: true, onClick, pausedReason: REASON },
				})}
			/>,
		);

		const upload = screen.getByRole("button", {
			name: "Upload new version",
		});
		await user.click(upload);

		expect(upload).toHaveAttribute("aria-disabled", "true");
		expect(onClick).not.toHaveBeenCalled();
		expect(toastInfo).toHaveBeenCalledWith(REASON);
	});

	it("keeps Add file but disabled, and says why when it is chosen", async () => {
		const user = userEvent.setup();
		const onOpen = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					addFile: { mode: "add", onOpen, pausedReason: REASON },
				})}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "More" }));
		const item = await screen.findByRole("menuitem", { name: "Add file" });
		await user.click(item);

		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(onOpen).not.toHaveBeenCalled();
		expect(toastInfo).toHaveBeenCalledWith(REASON);
	});

	it("still runs both when nothing is moving", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		const onOpen = vi.fn();
		render(
			<InstructionsActionBar
				actions={actions({
					upload: { published: true, onClick },
					addFile: { mode: "add", onOpen },
				})}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Upload new version" }),
		);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Add file" }),
		);

		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(toastInfo).not.toHaveBeenCalled();
	});
});
