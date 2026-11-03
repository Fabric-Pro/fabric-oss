/**
 * Project admins add people who are already in the organization by picking
 * them, without typing an address (Fizzy #1986, FR6-FR7).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getEligible, invite, toastSuccess, toastError } = vi.hoisted(() => ({
	getEligible: vi.fn(),
	invite: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { members: { getEligible, invite } },
	},
}));

vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { ProjectOrgMemberPicker } from "../ProjectOrgMemberPicker";

const PEOPLE = [
	{ id: "u1", name: "Ada Example", email: "ada@example.com", image: null },
	{ id: "u2", name: null, email: "noname@example.com", image: null },
];

const onAdded = vi.fn();

async function open() {
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					// The app's shared client also holds results for a minute.
					defaultOptions: {
						queries: { retry: false, staleTime: 60_000 },
					},
				})
			}
		>
			<ProjectOrgMemberPicker
				projectId="proj_1"
				organizationId="org_example"
				onAdded={onAdded}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Add from organization" }),
	);
	return await screen.findByRole("dialog");
}

function addButton(dialog: HTMLElement) {
	return within(dialog).getByRole("button", {
		name: /^Add/,
	}) as HTMLButtonElement;
}

beforeAll(() => {
	// Radix Select calls these when the listbox opens; jsdom has neither.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
});

beforeEach(() => {
	vi.clearAllMocks();
	getEligible.mockResolvedValue({ users: PEOPLE });
	invite.mockResolvedValue({ invitation: { id: "invitation_1" } });
});

describe("ProjectOrgMemberPicker", () => {
	it("lists eligible members and shows an address when there is no name", async () => {
		const dialog = await open();

		await within(dialog).findByText("Ada Example");
		expect(within(dialog).getByText("noname@example.com")).toBeTruthy();
		expect(getEligible).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_example",
			search: undefined,
		});
	});

	it("searches on the server", async () => {
		const dialog = await open();
		await within(dialog).findByText("Ada Example");

		fireEvent.change(within(dialog).getByRole("searchbox"), {
			target: { value: "ada" },
		});

		await waitFor(() =>
			expect(getEligible).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_example",
				search: "ada",
			}),
		);
	});

	it("adds several people as the chosen role, without typing an address", async () => {
		const dialog = await open();
		await within(dialog).findByText("Ada Example");

		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Ada/ }));
		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: /noname/ }),
		);
		fireEvent.click(addButton(dialog));

		await waitFor(() => expect(invite).toHaveBeenCalledTimes(2));
		expect(invite).toHaveBeenCalledWith({
			projectId: "proj_1",
			email: "ada@example.com",
			role: "VIEWER",
		});
		await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("keeps a selection when the search no longer shows that person", async () => {
		const dialog = await open();
		await within(dialog).findByText("Ada Example");
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Ada/ }));

		getEligible.mockResolvedValue({ users: [] });
		fireEvent.change(within(dialog).getByRole("searchbox"), {
			target: { value: "zzz" },
		});
		await within(dialog).findByText("No members found");
		fireEvent.click(addButton(dialog));

		await waitFor(() =>
			expect(invite).toHaveBeenCalledWith(
				expect.objectContaining({ email: "ada@example.com" }),
			),
		);
	});

	it("cannot add when nobody is selected", async () => {
		const dialog = await open();
		await within(dialog).findByText("Ada Example");

		expect(addButton(dialog).disabled).toBe(true);
	});

	it("reports who failed and keeps them selected", async () => {
		invite
			.mockResolvedValueOnce({ invitation: { id: "invitation_1" } })
			.mockRejectedValueOnce(new Error("Cannot invite this user"));
		const dialog = await open();
		await within(dialog).findByText("Ada Example");
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Ada/ }));
		fireEvent.click(
			within(dialog).getByRole("checkbox", { name: /noname/ }),
		);
		fireEvent.click(addButton(dialog));

		await within(dialog).findByText(/noname@example\.com: Cannot invite/);
		expect(toastError).toHaveBeenCalled();
		expect(onAdded).toHaveBeenCalledTimes(1);
	});

	it("does not offer the owner role", async () => {
		const dialog = await open();

		fireEvent.keyDown(within(dialog).getByRole("combobox"), {
			key: "Enter",
		});

		expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
		expect(screen.getByRole("option", { name: "Viewer" })).toBeTruthy();
	});

	it("reads eligibility again every time it opens", async () => {
		const dialog = await open();
		await within(dialog).findByText("Ada Example");
		expect(getEligible).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(
			screen.getByRole("button", { name: "Add from organization" }),
		);

		await waitFor(() => expect(getEligible).toHaveBeenCalledTimes(2));
	});

	it("says loading failed instead of claiming nobody was found, and can retry", async () => {
		getEligible.mockRejectedValueOnce(new Error("network"));
		const dialog = await open();

		await within(dialog).findByText("Could not load members");
		expect(within(dialog).queryByText("No members found")).toBeNull();

		fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));

		await within(dialog).findByText("Ada Example");
	});

	describe("while invitations are being sent", () => {
		let finish: () => void = () => undefined;

		async function sendOne() {
			invite.mockReturnValue(
				new Promise((resolve) => {
					finish = () => resolve({ invitation: { id: "i" } });
				}),
			);
			const dialog = await open();
			await within(dialog).findByText("Ada Example");
			fireEvent.click(
				within(dialog).getByRole("checkbox", { name: /Ada/ }),
			);
			fireEvent.click(addButton(dialog));
			await waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
			return dialog;
		}

		it("cannot be dismissed", async () => {
			const dialog = await sendOne();

			fireEvent.keyDown(dialog, { key: "Escape" });

			expect(screen.getByRole("dialog")).toBe(dialog);
			finish();
			await waitFor(() =>
				expect(screen.queryByRole("dialog")).toBeNull(),
			);
		});

		it("freezes the selection and the role", async () => {
			const dialog = await sendOne();

			const boxes = within(dialog).getAllByRole(
				"checkbox",
			) as HTMLButtonElement[];
			expect(boxes.every((box) => box.disabled)).toBe(true);
			expect(
				(within(dialog).getByRole("combobox") as HTMLButtonElement)
					.disabled,
			).toBe(true);
			finish();
		});
	});
});
