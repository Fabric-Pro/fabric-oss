/**
 * "Capture from" with the keyboard, on the real Radix select and dialog:
 * Enter chooses an environment and leaves its confirmation open for a
 * decision, and closing the confirmation returns focus to the picker.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The flag is inlined at build time; the picker's copy depends on it.
vi.mock("../settings-tab-navigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("../settings-tab-navigation")>()),
	ENVIRONMENT_SETTINGS_ENABLED: true,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			environments: {
				list: {
					queryOptions: (o: { input: unknown }) => o,
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: [{ id: "env-1", name: "Staging", type: "STAGING" }],
		isLoading: false,
	}),
}));

import { NewsletterImagesSetting } from "../NewsletterImagesSetting";

const onChange = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
});

/** Chooses Staging with Enter; returns the picker and the confirmation. */
async function chooseStagingWithEnter() {
	const user = userEvent.setup();
	render(
		<NewsletterImagesSetting
			projectId="p-1"
			screenshotsEnabled
			requireApproval
			screenshotEnvironmentId={null}
			disabled={false}
			onChange={onChange}
		/>,
	);
	const picker = screen.getByRole("combobox", { name: "Capture from" });

	await user.click(picker);
	const staging = await screen.findByRole("option", { name: "Staging" });
	act(() => staging.focus());
	await user.keyboard("{Enter}");

	return { user, picker, dialog: screen.getByRole("alertdialog") };
}

describe("NewsletterImagesSetting with the keyboard", () => {
	it("chooses an environment with Enter and keeps its confirmation open", async () => {
		const { dialog } = await chooseStagingWithEnter();

		expect(dialog).toHaveTextContent("Capture from Staging?");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("returns focus to the picker when the confirmation is cancelled", async () => {
		const { user, picker, dialog } = await chooseStagingWithEnter();
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });

		act(() => cancel.focus());
		await user.keyboard("{Enter}");

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		await waitFor(() => expect(picker).toHaveFocus());
		expect(onChange).not.toHaveBeenCalled();
	});

	it("returns focus to the picker once the environment is confirmed", async () => {
		const { user, picker, dialog } = await chooseStagingWithEnter();
		const sampleDataOnly = within(dialog).getByRole("checkbox", {
			name: "This environment shows sample data only",
		});
		const confirmButton = within(dialog).getByRole("button", {
			name: "Use this environment",
		});

		act(() => sampleDataOnly.focus());
		await user.keyboard(" ");
		act(() => confirmButton.focus());
		await user.keyboard("{Enter}");

		expect(onChange).toHaveBeenCalledWith({
			screenshotEnvironmentId: "env-1",
			screenshotSampleDataConfirmed: true,
		});
		await waitFor(() => expect(picker).toHaveFocus());
	});
});
