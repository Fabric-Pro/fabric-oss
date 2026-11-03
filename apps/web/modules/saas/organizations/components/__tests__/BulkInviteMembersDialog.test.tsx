/**
 * Pasting a list of addresses invites them as members and reports each one
 * (Fizzy #1986, FR1-FR5). A list over the limit never reaches the server.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bulk } = vi.hoisted(() => ({ bulk: vi.fn() }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { organizations: { invitations: { bulk } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BulkInviteMembersDialog } from "../BulkInviteMembersDialog";

const client = new QueryClient();

function open() {
	render(
		<QueryClientProvider client={client}>
			<BulkInviteMembersDialog organizationId="org_example" />
		</QueryClientProvider>,
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "organizations.settings.members.bulkInvite.open",
		}),
	);
}

function paste(text: string) {
	fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

function submit() {
	fireEvent.click(
		screen.getByRole("button", {
			name: /organizations\.settings\.members\.bulkInvite\.submit/,
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BulkInviteMembersDialog", () => {
	it("sends the parsed list and shows the outcome of each address", async () => {
		bulk.mockResolvedValue({
			results: [
				{ email: "a@example.com", status: "invited" },
				{ email: "bad", status: "invalid" },
			],
		});
		open();
		paste("a@example.com\nbad");
		submit();

		await screen.findByText("a@example.com");
		expect(bulk).toHaveBeenCalledWith({
			organizationId: "org_example",
			emails: ["a@example.com", "bad"],
		});
		expect(
			screen.getByText(
				"organizations.settings.members.bulkInvite.status.invited",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				"organizations.settings.members.bulkInvite.status.invalid",
			),
		).toBeTruthy();
	});

	it("announces the outcome through a region that was already mounted", async () => {
		bulk.mockResolvedValue({
			results: [{ email: "a@example.com", status: "invited" }],
		});
		open();
		const region = screen.getByRole("status");
		expect(region.textContent).toBe("");

		paste("a@example.com");
		submit();

		await waitFor(() =>
			expect(region.textContent).toContain(
				"organizations.settings.members.bulkInvite.summary",
			),
		);
		expect(screen.getByRole("status")).toBe(region);
	});

	it("states that invited people join as members", async () => {
		open();

		expect(
			screen.getByText(
				"organizations.settings.members.bulkInvite.description",
			),
		).toBeTruthy();
	});

	it("refuses a list over 500 before anything is sent", () => {
		open();
		paste(
			Array.from({ length: 501 }, (_, i) => `u${i}@example.com`).join(
				"\n",
			),
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"organizations.settings.members.bulkInvite.tooMany",
		);
		expect(
			(
				screen.getByRole("button", {
					name: /organizations\.settings\.members\.bulkInvite\.submit/,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(bulk).not.toHaveBeenCalled();
	});

	it("does nothing on an empty list", () => {
		open();

		expect(
			(
				screen.getByRole("button", {
					name: /organizations\.settings\.members\.bulkInvite\.submit/,
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("keeps the list when the request fails, so it can be retried", async () => {
		bulk.mockRejectedValue(new Error("network"));
		open();
		paste("a@example.com");
		submit();

		await waitFor(() => expect(bulk).toHaveBeenCalled());
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"a@example.com",
		);
	});

	it.each([
		["en", en],
		["de", de],
	])("has every string in %s", (_, messages) => {
		const copy = messages.organizations.settings.members.bulkInvite;

		for (const key of [
			"open",
			"title",
			"description",
			"placeholder",
			"submit",
			"tooMany",
			"error",
			"summary",
			"inviteMore",
		] as const) {
			expect(copy[key]).toBeTruthy();
		}
		for (const status of [
			"invited",
			"invalid",
			"duplicate",
			"already_member",
			"already_invited",
			"failed",
		] as const) {
			expect(copy.status[status]).toBeTruthy();
		}
	});
});
