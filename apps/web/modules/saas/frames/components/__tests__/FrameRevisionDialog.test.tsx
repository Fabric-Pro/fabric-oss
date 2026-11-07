import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";
import messages from "../../../../../../../packages/i18n/translations/en.json";

vi.mock("next-intl", async (actual) => await actual());
const m = vi.hoisted(() => ({
	update: vi.fn(),
	propose: vi.fn(),
	apply: vi.fn(),
	dismiss: vi.fn(),
	revert: vi.fn(),
	get: vi.fn(),
	history: vi.fn(),
	close: vi.fn(),
	saved: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			update: m.propose,
			proposeChange: m.propose,
			applyChange: m.apply,
			dismissChange: m.dismiss,
			revert: m.revert,
			get: m.get,
			getHistory: m.history,
		},
	},
}));

vi.mock("../FrameRenderer", () => ({
	FrameRenderer: ({ frame, allowScripts }: any) => (
		<div
			data-testid="frame-static-preview"
			data-scripts={String(allowScripts)}
		>
			{frame.title}
		</div>
	),
}));

import type { FrameDocumentView } from "../FrameRenderer";
import { FrameRevisionDialog } from "../FrameRevisionDialog";

const frame = {
	id: "example-frame",
	title: "Example report",
	updatedAt: "2026-11-01T00:00:00Z",
	document: {
		version: 1 as const,
		kind: "frame" as const,
		title: "Example report",
		blocks: [
			{ id: "page", type: "html" as const, content: "<p>Original</p>" },
		],
	},
};
function setup(
	initialTab: "edit" | "history" = "edit",
	document: FrameDocumentView = frame.document,
) {
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
					frame={{ ...frame, document }}
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
	m.propose.mockImplementation(async (input) => ({
		id: "example-proposal",
		frameId: frame.id,
		status: "PENDING",
		baseUpdatedAt: frame.updatedAt,
		baseContentHash: "a".repeat(64),
		proposedContentHash: "b".repeat(64),
		createdAt: frame.updatedAt,
		appliedUpdatedAt: null,
		summary: {
			titleChanged: true,
			descriptionChanged: false,
			presentationChanged: false,
			themeChanged: false,
			blocks: [],
		},
		base: frame.document,
		proposed: { ...frame.document, ...input.edit },
		currentUpdatedAt: frame.updatedAt,
		conflicted: false,
	}));
	m.apply.mockResolvedValue({ replayed: false });
	m.dismiss.mockResolvedValue({ status: "DISMISSED" });
	m.revert.mockResolvedValue({ success: true });
	m.saved.mockResolvedValue(undefined);
	m.get.mockResolvedValue(frame);
});
it("stages content without saving, previews statically and applies only after review", async () => {
	setup();
	await userEvent.clear(screen.getByRole("textbox", { name: "Title" }));
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		"Changed report",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Review changes" }),
	);
	expect(m.propose).toHaveBeenCalledWith({
		id: frame.id,
		organizationId: "example-org",
		requestId: expect.any(String),
		expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
		edit: { title: "Changed report", blocks: frame.document.blocks },
	});
	expect(m.apply).not.toHaveBeenCalled();
	expect(m.saved).not.toHaveBeenCalled();
	expect(screen.getByTestId("frame-static-preview")).toHaveAttribute(
		"data-scripts",
		"false",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Apply reviewed change" }),
	);
	expect(m.apply).toHaveBeenCalledWith({
		id: frame.id,
		organizationId: "example-org",
		proposalId: "example-proposal",
		expectedProposalHash: "b".repeat(64),
	});

	expect(m.saved).toHaveBeenCalledOnce();
});
it("retains the draft and base when a proposal conflicts, including after comparing the latest version", async () => {
	m.propose.mockRejectedValue({ code: "CONFLICT" });
	setup();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" draft",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Review changes" }),
	);
	await screen.findByRole("alert");
	expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Example report draft",
	);
	expect(m.close).not.toHaveBeenCalled();
	await userEvent.click(
		screen.getByRole("button", { name: "Compare latest version" }),
	);
	expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Example report draft",
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

it("does not apply again after a committed change cannot refresh", async () => {
	m.saved
		.mockRejectedValueOnce(new Error("Refresh unavailable"))
		.mockResolvedValue(undefined);
	setup();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" saved",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Review changes" }),
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Apply reviewed change" }),
	);
	await screen.findByRole("alert");
	expect(m.apply).toHaveBeenCalledOnce();
	await userEvent.click(
		screen.getByRole("button", { name: "Refresh saved artifact" }),
	);
	expect(m.apply).toHaveBeenCalledOnce();
	expect(m.close).toHaveBeenCalledOnce();
});

it("reviews an interface presentation change and saves it with the exact revision", async () => {
	setup();
	await userEvent.click(
		screen.getByRole("combobox", { name: "Presentation" }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: "Interface", exact: true }),
	);
	expect(
		screen.getByText(
			/Preserves the authored layout, colors and typography/,
		),
	).toBeVisible();
	await userEvent.click(
		screen.getByRole("button", { name: "Review changes" }),
	);
	expect(m.propose).toHaveBeenCalledWith(
		expect.objectContaining({
			edit: expect.objectContaining({ presentation: "INTERFACE" }),
			expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
		}),
	);
});

it("shows a report as a fixed document even if historical content requested interface", () => {
	setup("edit", {
		...frame.document,
		presentation: "INTERFACE",
		metadata: { sourceRunType: "REPORT_EXECUTION" },
	});
	expect(
		screen.getByRole("combobox", { name: "Presentation" }),
	).toBeDisabled();
	expect(
		screen.getByRole("combobox", { name: "Presentation" }),
	).toHaveTextContent("Document");
	expect(screen.getByText(/Reports use the document layout/)).toBeVisible();
});

it("treats Interface then Document as no effective change on legacy content", async () => {
	setup();
	await userEvent.click(
		screen.getByRole("combobox", { name: "Presentation" }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: "Interface", exact: true }),
	);
	await userEvent.click(
		screen.getByRole("combobox", { name: "Presentation" }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: "Document", exact: true }),
	);
	expect(
		screen.getByRole("button", { name: "Review changes" }),
	).toBeDisabled();
	await userEvent.click(
		screen.getByRole("button", { name: "Cancel", exact: true }),
	);
	expect(m.close).toHaveBeenCalledOnce();
	expect(screen.queryByText("Discard your unsaved changes?")).toBeNull();
});
it("retains omitted legacy presentation on content-only saves after a round trip through Interface", async () => {
	setup();
	await userEvent.click(
		screen.getByRole("combobox", { name: "Presentation" }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: "Interface", exact: true }),
	);
	await userEvent.click(
		screen.getByRole("combobox", { name: "Presentation" }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: "Document", exact: true }),
	);
	await userEvent.type(
		screen.getByRole("textbox", { name: "Title" }),
		" revised",
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Review changes" }),
	);
	expect(m.propose).toHaveBeenCalledOnce();
	expect(m.propose.mock.calls[0][0].edit).not.toHaveProperty("presentation");
});

it("shows both descriptions before a description-only change can be applied", async () => {
	const { FrameChangeReview } = await import("../FrameChangeReview");
	const base = {
		title: "Example",
		description: "Original example description",
		blocks: frame.document.blocks,
	};
	render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<FrameChangeReview
				proposal={{
					id: "example-proposal",
					frameId: frame.id,
					status: "PENDING",
					baseUpdatedAt: frame.updatedAt,
					baseContentHash: "a".repeat(64),
					proposedContentHash: "b".repeat(64),
					createdAt: frame.updatedAt,
					appliedUpdatedAt: null,
					currentUpdatedAt: frame.updatedAt,
					conflicted: false,
					base,
					proposed: {
						...base,
						description: "Proposed example description",
					},
					summary: {
						titleChanged: false,
						descriptionChanged: true,
						presentationChanged: false,
						themeChanged: false,
						blocks: [],
					},
				}}
				organizationId="example-org"
				kind="frame"
				onApplied={m.saved}
				onDismissed={m.close}
			/>
		</NextIntlClientProvider>,
	);
	await userEvent.click(
		screen.getByRole("tab", { name: "Changes", exact: true }),
	);
	expect(screen.getByText("Original example description")).toBeVisible();
	expect(screen.getByText("Proposed example description")).toBeVisible();
	expect(m.apply).not.toHaveBeenCalled();
});
