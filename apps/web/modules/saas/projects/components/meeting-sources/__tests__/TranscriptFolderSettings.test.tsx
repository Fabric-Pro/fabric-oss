/**
 * @vitest-environment jsdom
 */

/**
 * A project's connected OneDrive transcript folders (Fizzy #3507): counts that
 * stay marked as found-so-far until the folder is fully listed, the reason a
 * file was skipped, an empty folder said as such, a stopped folder with its
 * reconnect, and a disconnect that keeps what was imported.
 */

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
	list: vi.fn(),
	connect: vi.fn(),
	disconnect: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: mocks.confirm }),
}));

vi.mock("../ConnectTranscriptFolderDialog", () => ({
	ConnectTranscriptFolderDialog: () => null,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				connectFolders: mocks.connect,
				disconnectFolder: mocks.disconnect,
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			meetingTranscriptSync: {
				listFolders: {
					key: () => ["folders"],
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["folders", input],
						queryFn: () => mocks.list(input),
					}),
				},
			},
		},
	},
}));

import {
	describeFolderCounts,
	TranscriptFolderSettings,
} from "../TranscriptFolderSettings";

function folder(overrides: Record<string, unknown> = {}) {
	return {
		id: "folder-1",
		driveId: "drive-1",
		itemId: "item-1",
		name: "Transcripts",
		webUrl: "https://example-my.sharepoint.com/Transcripts",
		connectedByName: "Alex Example",
		lastSyncAt: null,
		lastSyncError: null,
		discoveryComplete: true,
		counts: {
			discovered: 10,
			imported: 6,
			skipped: 2,
			failed: 1,
			inProgress: 1,
		},
		problems: [
			{
				name: "Deck.pptx",
				status: "SKIPPED",
				reason: "Not a supported transcript format.",
			},
		],
		...overrides,
	};
}

function renderSettings(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<TranscriptFolderSettings
			projectId="project-1"
			organizationId="org-1"
			canEdit={canEdit}
		/>,
		{ wrapper },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue({ folders: [folder()] });
	mocks.connect.mockResolvedValue({ connected: 1 });
	mocks.disconnect.mockResolvedValue({ disconnected: true });
});

afterEach(() => {
	cleanup();
});

describe("describeFolderCounts", () => {
	it("marks the total as provisional until the folder is listed in full", () => {
		expect(
			describeFolderCounts(folder({ discoveryComplete: false }) as never),
		).toBe(
			"10 found so far · 6 imported · 1 in progress · 2 skipped · 1 failed",
		);
		expect(describeFolderCounts(folder() as never)).toBe(
			"10 files · 6 imported · 1 in progress · 2 skipped · 1 failed",
		);
	});
});

describe("TranscriptFolderSettings", () => {
	it("shows where an import stands and why a file was skipped", async () => {
		renderSettings();

		expect(await screen.findByText("Transcripts")).toBeInTheDocument();
		expect(
			screen.getByText(
				"10 files · 6 imported · 1 in progress · 2 skipped · 1 failed",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Deck.pptx: Not a supported transcript format."),
		).toBeInTheDocument();
		expect(screen.getByText(/Read as Alex Example/)).toBeInTheDocument();
	});

	it("says a folder with no files is empty, and what happens next", async () => {
		mocks.list.mockResolvedValue({
			folders: [
				folder({
					counts: {
						discovered: 0,
						imported: 0,
						skipped: 0,
						failed: 0,
						inProgress: 0,
					},
					problems: [],
				}),
			],
		});
		renderSettings();

		expect(
			await screen.findByText(/No files in this folder yet/),
		).toBeInTheDocument();
	});

	it("reconnects a stopped folder as the viewer", async () => {
		mocks.list.mockResolvedValue({
			folders: [
				folder({
					lastSyncError:
						"The Microsoft connection that reads this folder has stopped working.",
				}),
			],
		});
		renderSettings();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"has stopped working",
		);
		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

		await waitFor(() =>
			expect(mocks.connect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folders: [
					{
						driveId: "drive-1",
						itemId: "item-1",
						name: "Transcripts",
						webUrl: "https://example-my.sharepoint.com/Transcripts",
					},
				],
			}),
		);
	});

	it("disconnects only after saying that imported transcripts stay", async () => {
		renderSettings();
		fireEvent.click(
			await screen.findByRole("button", { name: "Disconnect" }),
		);

		const prompt = mocks.confirm.mock.calls[0]?.[0];
		expect(prompt.message).toContain(
			"Transcripts already imported stay in the project",
		);
		expect(mocks.disconnect).not.toHaveBeenCalled();
		await prompt.onConfirm();
		expect(mocks.disconnect).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
			folderId: "folder-1",
		});
	});

	it("offers no changes to someone who cannot edit", async () => {
		renderSettings(false);
		await screen.findByText("Transcripts");

		expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /connect folder/i }),
		).toBeNull();
	});
});
