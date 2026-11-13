/**
 * @vitest-environment jsdom
 */

/**
 * Choosing OneDrive transcript folders (Fizzy #3507).
 *
 * Pinned: browsing walks the viewer's own OneDrive, folders from different
 * levels can be chosen together, the card's disclosure is on screen before the
 * button that connects, and a missing Microsoft connection says what to do.
 */

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	browse: vi.fn(),
	connect: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: { connectFolders: mocks.connect },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			meetingTranscriptSync: {
				browseFolders: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["browse", input],
						queryFn: () => mocks.browse(input),
					}),
				},
				listFolders: { key: () => ["folders"] },
			},
		},
	},
}));

import { ConnectTranscriptFolderDialog } from "../ConnectTranscriptFolderDialog";

function renderDialog(onOpenChange = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(
		<ConnectTranscriptFolderDialog
			projectId="project-1"
			organizationId="org-1"
			open
			onOpenChange={onOpenChange}
		/>,
		{ wrapper },
	);
	return { onOpenChange };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.browse.mockImplementation(async (input: { itemId?: string }) =>
		input.itemId === "meetings"
			? {
					folders: [
						{
							driveId: "drive-1",
							itemId: "2026",
							name: "2026",
							childCount: 9,
							webUrl: null,
						},
					],
					transcriptFileCount: 3,
					truncated: false,
				}
			: {
					folders: [
						{
							driveId: "drive-1",
							itemId: "meetings",
							name: "Meetings",
							childCount: 4,
							webUrl: null,
						},
						{
							driveId: "drive-1",
							itemId: "notes",
							name: "Notes",
							childCount: 1,
							webUrl: null,
						},
					],
					transcriptFileCount: 0,
					truncated: false,
				},
	);
	mocks.connect.mockResolvedValue({ connected: 2, importStarted: true });
});

afterEach(() => {
	cleanup();
});

describe("ConnectTranscriptFolderDialog", () => {
	it("shows the disclosure before the connect button, with no way to skip existing files", async () => {
		renderDialog();
		await screen.findByText("Meetings");

		expect(
			screen.getByText(
				"Existing and future supported transcripts in these folders will be imported.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/only new/i)).toBeNull();
		expect(
			screen.getByRole("button", { name: /^connect/i }),
		).toBeDisabled();
	});

	it("connects folders chosen at different levels in one go", async () => {
		const { onOpenChange } = renderDialog();
		fireEvent.click(
			await screen.findByRole("checkbox", { name: "Select Notes" }),
		);

		fireEvent.click(screen.getByRole("button", { name: /Meetings/ }));
		expect(
			await screen.findByText(/3 supported transcripts here/),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("checkbox", { name: /use this folder/i }),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Connect 2 folders" }),
		);

		await waitFor(() =>
			expect(mocks.connect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folders: [
					{
						driveId: "drive-1",
						itemId: "notes",
						name: "Notes",
						webUrl: null,
					},
					{
						driveId: "drive-1",
						itemId: "meetings",
						name: "Meetings",
					},
				],
			}),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(mocks.toastSuccess).toHaveBeenCalled();
	});

	it("walks back up from the folder path", async () => {
		renderDialog();
		fireEvent.click(
			await screen.findByRole("button", { name: /Meetings/ }),
		);
		await screen.findByText("2026");

		fireEvent.click(screen.getByRole("button", { name: "My OneDrive" }));

		expect(await screen.findByText("Notes")).toBeInTheDocument();
	});

	it("asks for a Microsoft connection when there is none", async () => {
		mocks.browse.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "Connect your Microsoft account.",
				data: { code: "MICROSOFT_NOT_CONNECTED" },
			}),
		);
		renderDialog();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Connect your Microsoft account in Settings → Integrations",
		);
	});
});
