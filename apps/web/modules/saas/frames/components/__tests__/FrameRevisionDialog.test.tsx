import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.mock("next-intl", async (actual) => await actual());
const m = vi.hoisted(() => ({
	update: vi.fn(),
	revert: vi.fn(),
	get: vi.fn(),
	history: vi.fn(),
	close: vi.fn(),
	saved: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			update: m.update,
			revert: m.revert,
			get: m.get,
			getHistory: m.history,
		},
	},
}));

import { FrameRevisionDialog } from "../FrameRevisionDialog";

const frame = {
	id: "example-frame",
	title: "Example report",
	updatedAt: "2026-11-01T00:00:00Z",
	document: {
		version: 1,
		kind: "frame" as const,
		title: "Example report",
		blocks: [
			{ id: "page", type: "html" as const, content: "<p>Original</p>" },
		],
	},
};
function setup(initialTab: "edit" | "history" = "edit") {
	return render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<FrameRevisionDialog
					frame={frame}
					organizationId="example-org"
					userId="example-user"
					initialTab={initialTab}
					onClose={m.close}
					onSaved={m.saved}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	m.history.mockResolvedValue({
		history: [
			{
				id: "example-entry",
				editType: "full_update",
				editedAt: "2026-11-01T00:00:00Z",
				canRestore: true,
			},
		],
	});
	m.update.mockResolvedValue({});
	m.revert.mockResolvedValue({ success: true });
	m.saved.mockResolvedValue(undefined);
	m.get.mockResolvedValue(frame);
});
it("saves the reviewed revision with content only", async () => {
	setup();
	await userEvent.clear(screen.getByRole("textbox", { name: "Title" }));
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		"Changed report",
	);
	await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
	expect(m.update).toHaveBeenCalledWith({
		id: frame.id,
		organizationId: "example-org",
		expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
		title: "Changed report",
		blocks: frame.document.blocks,
	});
	expect(m.saved).toHaveBeenCalledOnce();
});
it("retains the draft when a save conflicts and reloads only on explicit discard", async () => {
	m.update.mockRejectedValue({ code: "CONFLICT" });
	setup();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" draft",
	);
	await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await screen.findByRole("alert");
	expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Example report draft",
	);
	expect(m.close).not.toHaveBeenCalled();
	await userEvent.click(
		screen.getByRole("button", { name: "Reload and discard this draft" }),
	);
	expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Example report",
	);
});
it("requires confirmation before restoring an exact history entry", async () => {
	setup("history");
	await userEvent.click(
		await screen.findByRole("button", { name: "Restore", exact: true }),
	);
	expect(m.revert).not.toHaveBeenCalled();
	await userEvent.click(
		screen.getByRole("button", { name: "Restore saved content" }),
	);
	expect(m.revert).toHaveBeenCalledWith({
		id: frame.id,
		organizationId: "example-org",
		historyEntryId: "example-entry",
		expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
	});
});
it("keeps unsaved changes when closing until discard is confirmed", async () => {
	setup();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" draft",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Cancel", exact: true }),
	);
	expect(m.close).not.toHaveBeenCalled();
	await screen.findByText("Discard your unsaved changes?");
	await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
	expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Example report draft",
	);
});

it("does not resubmit a committed edit when its refresh fails", async () => {
	m.saved
		.mockRejectedValueOnce(new Error("Refresh unavailable"))
		.mockResolvedValue(undefined);
	setup();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" saved",
	);
	await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await screen.findByText(/Saved successfully. The page could not refresh/);
	expect(m.update).toHaveBeenCalledOnce();
	expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	await userEvent.click(
		screen.getByRole("button", { name: "Reload saved page" }),
	);
	expect(m.update).toHaveBeenCalledOnce();
	expect(m.close).toHaveBeenCalledOnce();
});
