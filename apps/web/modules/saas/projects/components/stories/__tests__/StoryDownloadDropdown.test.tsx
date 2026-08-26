/**
 * Component tests for `StoryDownloadDropdown`.
 *
 * Verifies:
 *   - All three format items render with the correct labels.
 *   - Markdown click triggers a `text/markdown` blob download with the
 *     expected slugged filename.
 *   - PDF / DOCX clicks dynamic-import the matching renderer and hand the
 *     produced blob to `triggerBlobDownload`.
 *   - Stub features keep the menu enabled but show a toast and do NOT
 *     invoke any renderer.
 *   - The icon variant carries an `aria-label` and tooltip.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StoryDownloadDropdown } from "../StoryDownloadDropdown";

// Mock the renderer module — every test asserts on these mocks rather than
// on the real jsPDF / docx libraries (which need a DOM canvas / fonts).
const triggerBlobDownloadMock = vi.fn();
const renderMarkdownToPdfMock = vi.fn(async () => new Blob(["pdf-bytes"]));
const renderMarkdownToDocxMock = vi.fn(async () => new Blob(["docx-bytes"]));

vi.mock("../../../lib/markdown-to-document", () => ({
	triggerBlobDownload: triggerBlobDownloadMock,
	renderMarkdownToPdf: renderMarkdownToPdfMock,
	renderMarkdownToDocx: renderMarkdownToDocxMock,
}));

const toastWarningMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		warning: (...args: unknown[]) => toastWarningMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
	},
}));

const PROJECT = { id: "proj-1", name: "Acme Web" };

function buildStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story-1",
		identifier: "F-1166",
		title: "As a user, I want to authenticate with passkeys",
		description: "Allow customers to sign in with WebAuthn passkeys.",
		acceptanceCriteria: "- Browser supports WebAuthn.",
		statusId: "status-1",
		kind: "FEATURE" as UserStory["kind"],
		priority: "P1_HIGH" as UserStory["priority"],
		size: "M" as UserStory["size"],
		storyPoints: null,
		order: 1,
		roadmapOrder: 1,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		updatedAt: new Date("2026-05-01T00:00:00.000Z"),
		externalId: null,
		externalUrl: null,
		source: "manual",
		version: 1,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		...overrides,
	} as UserStory;
}

describe("StoryDownloadDropdown", () => {
	beforeEach(() => {
		triggerBlobDownloadMock.mockReset();
		renderMarkdownToPdfMock.mockClear();
		renderMarkdownToDocxMock.mockClear();
		toastWarningMock.mockReset();
		toastErrorMock.mockReset();
	});

	it("renders three dropdown items with correct i18n keys", async () => {
		const user = userEvent.setup();
		render(
			<StoryDownloadDropdown story={buildStory()} project={PROJECT} />,
		);

		await user.click(screen.getByRole("button", { name: /action/i }));

		expect(screen.getByText("format.markdown")).toBeInTheDocument();
		expect(screen.getByText("format.pdf")).toBeInTheDocument();
		expect(screen.getByText("format.docx")).toBeInTheDocument();
	});

	it("Markdown click invokes triggerBlobDownload with a text/markdown blob and slugged filename", async () => {
		const user = userEvent.setup();
		render(
			<StoryDownloadDropdown story={buildStory()} project={PROJECT} />,
		);

		await user.click(screen.getByRole("button", { name: /action/i }));
		await user.click(screen.getByText("format.markdown"));

		await waitFor(() => {
			expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		});
		const [blob, filename] = triggerBlobDownloadMock.mock.calls[0];
		expect(blob).toBeInstanceOf(Blob);
		expect((blob as Blob).type).toMatch(/^text\/markdown/);
		expect(filename).toMatch(
			/^f-1166-as-a-user-i-want-to-authenticate-with-passkeys\.md$/,
		);
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(renderMarkdownToDocxMock).not.toHaveBeenCalled();
	});

	it("PDF click dynamic-imports renderMarkdownToPdf and downloads the blob", async () => {
		const user = userEvent.setup();
		render(
			<StoryDownloadDropdown story={buildStory()} project={PROJECT} />,
		);

		await user.click(screen.getByRole("button", { name: /action/i }));
		await user.click(screen.getByText("format.pdf"));

		await waitFor(() => {
			expect(renderMarkdownToPdfMock).toHaveBeenCalledTimes(1);
		});
		expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		const [, filename] = triggerBlobDownloadMock.mock.calls[0];
		expect(filename).toMatch(/\.pdf$/);
	});

	it("DOCX click dynamic-imports renderMarkdownToDocx and downloads the blob", async () => {
		const user = userEvent.setup();
		render(
			<StoryDownloadDropdown story={buildStory()} project={PROJECT} />,
		);

		await user.click(screen.getByRole("button", { name: /action/i }));
		await user.click(screen.getByText("format.docx"));

		await waitFor(() => {
			expect(renderMarkdownToDocxMock).toHaveBeenCalledTimes(1);
		});
		expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		const [, filename] = triggerBlobDownloadMock.mock.calls[0];
		expect(filename).toMatch(/\.docx$/);
	});

	it("stub feature shows a warning toast and skips every renderer", async () => {
		const user = userEvent.setup();
		render(
			<StoryDownloadDropdown
				story={buildStory({
					description: null,
					acceptanceCriteria: null,
					tasks: [],
					draftingStage: "PLACEHOLDER",
				})}
				project={PROJECT}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /action/i }));
		await user.click(screen.getByText("format.markdown"));

		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalledWith("stubBlocked");
		});
		expect(triggerBlobDownloadMock).not.toHaveBeenCalled();
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(renderMarkdownToDocxMock).not.toHaveBeenCalled();
	});

	it("icon variant exposes aria-label and renders an icon-only trigger", () => {
		render(
			<StoryDownloadDropdown
				story={buildStory()}
				project={PROJECT}
				variant="icon"
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: /storyDownload/i,
		});
		expect(trigger).toBeInTheDocument();
		expect(trigger.getAttribute("aria-label")).toMatch(/storyDownload/i);
	});
});
