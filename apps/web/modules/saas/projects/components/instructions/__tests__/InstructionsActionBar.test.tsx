/**
 * The Coding Instructions header: what it offers and in what order. Review
 * proposals (with a count) first when something is waiting, then History,
 * Download and an icon-only More, and the one primary action last, named for
 * what it does. Connecting an agent is not here.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import {
	InstructionsActionBar,
	type InstructionsActions,
} from "../InstructionsActionBar";

function actions(
	overrides: Partial<InstructionsActions> = {},
): InstructionsActions {
	return {
		upload: { published: true, onClick: vi.fn() },
		history: { onOpen: vi.fn() },
		download: { pending: false, onDownload: vi.fn() },
		settings: { onOpen: vi.fn() },
		...overrides,
	};
}

function headerButtonNames() {
	return within(screen.getByTestId("instructions-actions"))
		.getAllByRole("button")
		.map(
			(button) => button.getAttribute("aria-label") ?? button.textContent,
		);
}

async function openMore() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "More" }));
	return user;
}

describe("InstructionsActionBar", () => {
	it("puts History, Download and More before the primary action, which comes last", () => {
		render(<InstructionsActionBar actions={actions()} />);

		expect(headerButtonNames()).toEqual([
			"History",
			"Download",
			"More",
			"Upload new version",
		]);
	});

	it("names the primary action for what it does: Upload new version when something is published, Upload folder when not", () => {
		const { unmount } = render(
			<InstructionsActionBar actions={actions()} />,
		);
		expect(
			screen.getByRole("button", { name: "Upload new version" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Replace" }),
		).not.toBeInTheDocument();
		unmount();

		render(
			<InstructionsActionBar
				actions={actions({
					upload: { published: false, onClick: vi.fn() },
				})}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Upload folder" }),
		).toBeInTheDocument();
	});

	it("has no primary action for someone who cannot upload", () => {
		render(
			<InstructionsActionBar actions={actions({ upload: undefined })} />,
		);

		expect(headerButtonNames()).toEqual(["History", "Download", "More"]);
	});

	it("does not carry Connect your agent, which sits beside Fabric MCP in the status strip", () => {
		render(<InstructionsActionBar actions={actions()} />);

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
		expect(
			document.querySelector(
				'[data-onboarding-target="coding-instructions-connect"]',
			),
		).toBeNull();
	});

	it("says Commits, not History, on a repository project", () => {
		render(
			<InstructionsActionBar
				actions={actions({
					history: { onOpen: vi.fn(), commits: true },
				})}
			/>,
		);

		expect(screen.getByRole("button", { name: "Commits" })).toHaveAttribute(
			"data-onboarding-target",
			"coding-instructions-history",
		);
		expect(
			screen.queryByRole("button", { name: "History" }),
		).not.toBeInTheDocument();
	});

	it("makes More an icon-only button named by its label, anchoring the menu's tour step", () => {
		render(<InstructionsActionBar actions={actions()} />);

		const more = screen.getByRole("button", { name: "More" });

		expect(more).toHaveAttribute(
			"data-onboarding-target",
			"instructions-more-actions",
		);
		expect(more.textContent).toBe("");
	});

	describe("proposals waiting for this viewer", () => {
		const proposals = (awaitingReview: number, onOpen = vi.fn()) => ({
			label: "reviewProposalsButton" as const,
			onOpen,
			awaitingReview,
		});

		it("shows Review proposals with the count first in the header, and nowhere in the menu", async () => {
			const onOpen = vi.fn();
			render(
				<InstructionsActionBar
					actions={actions({ proposals: proposals(3, onOpen) })}
				/>,
			);

			expect(headerButtonNames()).toEqual([
				"Review proposals, 3 waiting",
				"History",
				"Download",
				"More",
				"Upload new version",
			]);
			const review = screen.getByRole("button", {
				name: "Review proposals, 3 waiting",
			});
			expect(review).toHaveTextContent("Review proposals");
			expect(review).toHaveTextContent("3");

			const user = await openMore();
			expect(
				screen.queryByRole("menuitem", { name: "Review proposals" }),
			).not.toBeInTheDocument();
			await user.keyboard("{Escape}");
			await user.click(review);
			expect(onOpen).toHaveBeenCalledTimes(1);
		});

		it("keeps the entry in the menu, and out of the header, when nothing is waiting", async () => {
			render(
				<InstructionsActionBar
					actions={actions({ proposals: proposals(0) })}
				/>,
			);

			expect(headerButtonNames()).toEqual([
				"History",
				"Download",
				"More",
				"Upload new version",
			]);
			await openMore();
			expect(
				screen.getByRole("menuitem", { name: "Review proposals" }),
			).toBeInTheDocument();
		});

		it("keeps the entry in the menu when no count was read", async () => {
			render(
				<InstructionsActionBar
					actions={actions({
						proposals: {
							label: "proposalsButton",
							onOpen: vi.fn(),
						},
					})}
				/>,
			);

			await openMore();
			expect(
				screen.getByRole("menuitem", { name: "Your proposals" }),
			).toBeInTheDocument();
		});
	});

	describe("the More menu", () => {
		it("holds Add file and Settings for an editor, Settings last after a separator", async () => {
			render(
				<InstructionsActionBar
					actions={actions({
						addFile: { mode: "add", onOpen: vi.fn() },
					})}
				/>,
			);

			await openMore();

			expect(
				screen.getAllByRole("menuitem").map((item) => item.textContent),
			).toEqual(["Add file", "Settings"]);
			expect(screen.getByRole("separator")).toBeInTheDocument();
		});

		it("holds only Settings, with no separator, for a reader", async () => {
			render(<InstructionsActionBar actions={actions()} />);

			await openMore();

			expect(
				screen.getAllByRole("menuitem").map((item) => item.textContent),
			).toEqual(["Settings"]);
			expect(screen.queryByRole("separator")).not.toBeInTheDocument();
		});

		it("holds the repository actions before the rest", async () => {
			render(
				<InstructionsActionBar
					actions={actions({
						syncNow: {
							running: false,
							busy: false,
							onSync: vi.fn(),
						},
						syncFromRepository: { onOpen: vi.fn() },
						proposals: {
							label: "suggestionsButton",
							onOpen: vi.fn(),
						},
						addFile: { mode: "suggest", onOpen: vi.fn() },
					})}
				/>,
			);

			await openMore();

			expect(
				screen.getAllByRole("menuitem").map((item) => item.textContent),
			).toEqual([
				"Sync now",
				"Sync from repository",
				"Suggested changes",
				"Suggest a change",
				"Settings",
			]);
		});
	});
});
