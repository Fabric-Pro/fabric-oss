/**
 * Typed confirmation on the shared destructive dialog (Fizzy #2462).
 *
 * The gate exists because a yes/no dialog only asks "are you sure", which a
 * reflex answers. These tests pin the three properties that make the control
 * worth having at all: it blocks until the value matches, it matches exactly
 * rather than loosely, and it does NOT carry an answer from one dialog to the
 * next — a stale match would silently confirm a different target.
 */
import {
	ConfirmationAlertProvider,
	useConfirmationAlert,
} from "@saas/shared/components/ConfirmationAlertProvider";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

const onConfirm = vi.fn();

function Harness({
	expected,
	target = "example-org",
}: {
	expected?: string;
	target?: string;
}) {
	const { confirm } = useConfirmationAlert();

	return (
		<button
			type="button"
			onClick={() =>
				confirm({
					title: `Delete ${target}?`,
					message: "This cannot be undone.",
					destructive: true,
					onConfirm,
					...(expected
						? {
								requireTypedConfirmation: {
									expected,
									label: `Type ${expected} to confirm`,
								},
							}
						: {}),
				})
			}
		>
			open
		</button>
	);
}

function renderHarness(props: { expected?: string; target?: string } = {}) {
	return render(
		<ConfirmationAlertProvider>
			<Harness {...props} />
		</ConfirmationAlertProvider>,
	);
}

const openDialog = () => fireEvent.click(screen.getByText("open"));
const confirmButton = () =>
	screen.getByRole("button", { name: "common.confirmation.confirm" });

describe("typed confirmation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps confirm disabled until the typed value matches", async () => {
		renderHarness({ expected: "example-org" });
		openDialog();

		await waitFor(() => expect(confirmButton()).toBeDisabled());

		fireEvent.change(screen.getByLabelText(/Type example-org/), {
			target: { value: "example-or" },
		});
		expect(confirmButton()).toBeDisabled();

		fireEvent.change(screen.getByLabelText(/Type example-org/), {
			target: { value: "example-org" },
		});
		await waitFor(() => expect(confirmButton()).toBeEnabled());

		fireEvent.click(confirmButton());
		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
	});

	it("does not accept a different case", async () => {
		renderHarness({ expected: "example-org" });
		openDialog();

		fireEvent.change(await screen.findByLabelText(/Type example-org/), {
			target: { value: "Example-Org" },
		});

		expect(confirmButton()).toBeDisabled();
	});

	it("tolerates surrounding whitespace, which a paste usually carries", async () => {
		renderHarness({ expected: "example-org" });
		openDialog();

		fireEvent.change(await screen.findByLabelText(/Type example-org/), {
			target: { value: "  example-org  " },
		});

		await waitFor(() => expect(confirmButton()).toBeEnabled());
	});

	it("clears the typed value when the dialog is dismissed and reopened", async () => {
		// The failure this guards: dismiss, reopen on a DIFFERENT target, and
		// find the gate already satisfied by the previous answer.
		renderHarness({ expected: "example-org" });
		openDialog();

		fireEvent.change(await screen.findByLabelText(/Type example-org/), {
			target: { value: "example-org" },
		});
		await waitFor(() => expect(confirmButton()).toBeEnabled());

		fireEvent.click(
			screen.getByRole("button", { name: "common.confirmation.cancel" }),
		);
		openDialog();

		await waitFor(() => expect(confirmButton()).toBeDisabled());
		expect(await screen.findByLabelText(/Type example-org/)).toHaveValue(
			"",
		);
	});

	it("leaves dialogs without the option completely unchanged", async () => {
		renderHarness();
		openDialog();

		// No gate, no field, and confirm is live immediately — every existing
		// caller of this provider depends on exactly this.
		await waitFor(() => expect(confirmButton()).toBeEnabled());
		expect(screen.queryByLabelText(/to confirm/)).toBeNull();
	});
});
