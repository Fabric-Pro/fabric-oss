/**
 * Behavioral guarantees of the shared confirmation dialog (#1905).
 *
 * Fixed here:
 *   D1 — a rejecting `onConfirm` left the dialog open forever with a live
 *        confirm button, plus an unhandled rejection, because
 *        `setConfirmOptions(null)` only ran on the success path. Every caller
 *        uses `await mutateAsync(...)`, which rejects on failure even when an
 *        `onError` callback is present, so this fired on any server error.
 *   D1b — Escape and Cancel could abandon an in-flight destructive action,
 *        closing the dialog while the mutation was still running.
 *
 * Explicitly NOT a defect, contrary to the first pass of the review: repeated
 * confirm clicks. `Button` defaults to `autoLoading` and its `handleClick`
 * returns early while a returned promise is pending, so the re-entrancy guard
 * already exists one layer down. The first test below pins that guarantee so it
 * cannot regress if that default ever changes; the provider also keeps its own
 * ref guard so the guarantee does not depend on the primitive.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

import {
	ConfirmationAlertProvider,
	useConfirmationAlert,
} from "../ConfirmationAlertProvider";

function Trigger({ onConfirm }: { onConfirm: () => Promise<void> | void }) {
	const { confirm } = useConfirmationAlert();
	return (
		<button
			type="button"
			onClick={() =>
				confirm({
					title: "Unlink thing?",
					message: "This cannot be undone.",
					confirmLabel: "Unlink",
					destructive: true,
					onConfirm,
				})
			}
		>
			open
		</button>
	);
}

function renderWithProvider(onConfirm: () => Promise<void> | void) {
	return render(
		<ConfirmationAlertProvider>
			<Trigger onConfirm={onConfirm} />
		</ConfirmationAlertProvider>,
	);
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "open" }));
	return await screen.findByRole("button", { name: "Unlink" });
}

describe("ConfirmationAlertProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invokes onConfirm once even when confirm is clicked repeatedly", async () => {
		const user = userEvent.setup();
		let release: (() => void) | undefined;
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		renderWithProvider(onConfirm);
		const confirmButton = await openDialog(user);

		await user.click(confirmButton);
		await user.click(confirmButton);
		await user.click(confirmButton);

		expect(onConfirm).toHaveBeenCalledTimes(1);

		release?.();
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Unlink" }),
			).not.toBeInTheDocument();
		});
	});

	it("closes the dialog when onConfirm rejects, and does not reject outward (D1)", async () => {
		const user = userEvent.setup();
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const onConfirm = vi.fn(() =>
			Promise.reject(new Error("server said no")),
		);

		renderWithProvider(onConfirm);
		const confirmButton = await openDialog(user);

		await user.click(confirmButton);

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Unlink" }),
			).not.toBeInTheDocument();
		});
		expect(consoleError).toHaveBeenCalled();

		consoleError.mockRestore();
	});

	it("ignores Escape while onConfirm is in flight", async () => {
		const user = userEvent.setup();
		let release: (() => void) | undefined;
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		renderWithProvider(onConfirm);
		const confirmButton = await openDialog(user);
		await user.click(confirmButton);

		await user.keyboard("{Escape}");
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();

		release?.();
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		});
	});

	it("does not let Cancel abandon an in-flight action", async () => {
		const user = userEvent.setup();
		let release: (() => void) | undefined;
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		renderWithProvider(onConfirm);
		const confirmButton = await openDialog(user);
		await user.click(confirmButton);

		// AlertDialogCancel is a Radix element, not our Button, so it has no
		// autoLoading guard of its own — the provider has to disable it.
		await user.click(
			screen.getByRole("button", { name: "common.confirmation.cancel" }),
		);
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();

		release?.();
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		});
	});

	it("closes on Escape when idle, without invoking onConfirm", async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn();

		renderWithProvider(onConfirm);
		await openDialog(user);

		await user.keyboard("{Escape}");

		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		});
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
