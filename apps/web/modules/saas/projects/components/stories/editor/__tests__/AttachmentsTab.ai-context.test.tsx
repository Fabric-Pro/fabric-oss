/**
 * The panel's AI-context surface, which has to say three true things at once.
 *
 * 1. Context only is OPT-IN per upload, defaulting off. `designation` governs
 *    deletion as well as AI visibility, so a default-on would quietly strip new
 *    files of delete protection — an unrelated behavior change riding along
 *    with an AI feature.
 *
 * 2. The state is visible as text, not just a lock glyph. The glyph's
 *    aria-label names the ACTION ("Lock notes.md"), so on its own it tells a
 *    screen-reader user nothing about which files the AI can see.
 *
 * 3. A context-only file whose format has no extractable text says so —
 *    otherwise the badge promises something the pipeline does not deliver and
 *    the user believes the model read their screenshot.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../../lib/stories/types";
import { AttachmentsTab } from "../AttachmentsTab";

const { uploadStoryAttachment, listAttachments } = vi.hoisted(() => ({
	uploadStoryAttachment: vi.fn(),
	listAttachments: vi.fn(),
}));

vi.mock("../../../../lib/attachment-upload-utils", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../lib/attachment-upload-utils")
		>();
	return { ...actual, uploadStoryAttachment };
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				listAttachments,
				removeAttachment: vi.fn().mockResolvedValue({ removed: true }),
				setAttachmentDesignation: vi.fn().mockResolvedValue({
					attachment: { id: "a1", designation: "UNLOCKED" },
				}),
			},
		},
	},
}));

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const story = { id: "s1", description: "" } as unknown as UserStory;
const baseProps = {
	story,
	projectId: "p1",
	organizationId: null as string | null,
};

function attachment(overrides: Record<string, unknown> = {}) {
	return {
		id: "a1",
		filename: "notes.md",
		mimeType: "text/markdown",
		sizeBytes: 2048,
		designation: "UNLOCKED",
		createdAt: new Date(0),
		downloadUrl: "https://dl/a1",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	listAttachments.mockResolvedValue({ attachments: [attachment()] });
	uploadStoryAttachment.mockResolvedValue(attachment());
});

describe("AttachmentsTab — AI context surface", () => {
	function uploadFile(name = "spec.md") {
		const dropzone = screen.getByRole("button", {
			name: /drag files here/i,
		});
		const input = dropzone.parentElement?.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(["x"], name)] } });
	}

	it("uploads as a protected asset by default", async () => {
		// Omitting `designation` lets the server default to LOCKED. Asserting on
		// the absence is the point: passing "LOCKED" explicitly would look the
		// same today and diverge the day the server default changes.
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		uploadFile();

		await waitFor(() => expect(uploadStoryAttachment).toHaveBeenCalled());
		expect(uploadStoryAttachment.mock.calls[0][0]).not.toHaveProperty(
			"designation",
		);
	});

	it("uploads as context-only when the user opts in", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		fireEvent.click(
			screen.getByRole("checkbox", { name: /context only/i }),
		);
		uploadFile();

		await waitFor(() => expect(uploadStoryAttachment).toHaveBeenCalled());
		expect(uploadStoryAttachment).toHaveBeenCalledWith(
			expect.objectContaining({ designation: "UNLOCKED" }),
		);
	});

	it("offers the opt-in only when the user can edit", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={false} />));
		await screen.findByText("notes.md");

		expect(
			screen.queryByRole("checkbox", { name: /context only/i }),
		).not.toBeInTheDocument();
	});

	// Scoped to the file row: the upload opt-in's own label also reads
	// "Context only", so a document-wide query would match it and pass (or
	// collide) regardless of how the row is actually rendered.
	const rowBadge = (): HTMLElement | null =>
		within(screen.getByRole("listitem")).queryByText("Context only");

	it("labels a context-only file as such, in text", async () => {
		// The lock glyph alone fails the not-by-colour-alone bar.
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		expect(rowBadge()).toBeInTheDocument();
	});

	it("does not label a protected file as context-only", async () => {
		listAttachments.mockResolvedValue({
			attachments: [attachment({ designation: "LOCKED" })],
		});

		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		expect(rowBadge()).not.toBeInTheDocument();
	});

	it("exposes the designation as toggle state, not just an action", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		// aria-label says "Lock notes.md" (the action); aria-pressed is what
		// tells a screen reader the file is currently context-only.
		expect(
			screen.getByRole("button", { name: /lock notes\.md/i }),
		).toHaveAttribute("aria-pressed", "true");
	});

	it("marks a context-only image as not read by the AI", async () => {
		listAttachments.mockResolvedValue({
			attachments: [
				attachment({ filename: "mockup.png", mimeType: "image/png" }),
			],
		});

		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("mockup.png");

		expect(await screen.findByText(/not read by ai/i)).toBeInTheDocument();
	});

	it("does not mark a context-only text file", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("notes.md");

		expect(screen.queryByText(/not read by ai/i)).not.toBeInTheDocument();
	});

	it("does not mark a protected image", async () => {
		// A protected file was never going to reach the AI, so the label would
		// be noise rather than a correction.
		listAttachments.mockResolvedValue({
			attachments: [
				attachment({
					filename: "mockup.png",
					mimeType: "image/png",
					designation: "LOCKED",
				}),
			],
		});

		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("mockup.png");

		expect(screen.queryByText(/not read by ai/i)).not.toBeInTheDocument();
	});

	it("conveys the distinction as text, readable without colour", async () => {
		listAttachments.mockResolvedValue({
			attachments: [
				attachment({ filename: "clip.mp4", mimeType: "video/mp4" }),
			],
		});

		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("clip.mp4");

		// The assertion IS the accessibility guarantee: the state is carried by
		// a text node a screen reader announces, not by a colour swatch.
		const label = await screen.findByText(/not read by ai/i);
		expect(label.textContent?.trim()).toBe("Not read by AI");
	});

	it("still renders the label in read-only mode", async () => {
		// Someone reviewing a ticket they cannot edit still needs to know what
		// the AI did and did not see.
		listAttachments.mockResolvedValue({
			attachments: [
				attachment({ filename: "mockup.png", mimeType: "image/png" }),
			],
		});

		render(wrap(<AttachmentsTab {...baseProps} canEdit={false} />));
		await screen.findByText("mockup.png");

		expect(await screen.findByText(/not read by ai/i)).toBeInTheDocument();
	});
});
