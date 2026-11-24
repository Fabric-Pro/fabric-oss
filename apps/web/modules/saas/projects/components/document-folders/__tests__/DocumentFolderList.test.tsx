/**
 * @vitest-environment jsdom
 */

/**
 * The Document folders section of the Context tab (Fizzy #2808).
 *
 * Pinned: hidden while the feature is off or no folder is connected; one
 * state per card with its text and next step; Sync now held back with its
 * reason while a read runs; held removals confirmed with their count; the
 * description edited in place; disconnect and reconnect confirmed with what
 * they do; a reconnect without a Microsoft connection runs the connect flow
 * first; viewers see no actions and no reader; focus returns to the opener;
 * the read an action starts shows within seconds; the page learns which
 * folders are connected.
 */

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flag: { on: true },
	list: vi.fn(),
	updateDescription: vi.fn(),
	syncNow: vi.fn(),
	reconnect: vi.fn(),
	confirmRemovals: vi.fn(),
	disconnect: vi.fn(),
	oauthStart: vi.fn(),
	openPopup: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastWarning: vi.fn(),
	toastInfo: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: mocks.toastSuccess,
		error: mocks.toastError,
		warning: mocks.toastWarning,
		info: mocks.toastInfo,
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "CLOUD_DRIVE_FOLDERS" ? mocks.flag.on : false,
}));

vi.mock("@shared/lib/oauth-popup", () => ({
	openOAuthPopup: mocks.openPopup,
	POPUP_BLOCKED_MESSAGE: "Popup blocked",
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documentFolders: {
				updateDescription: mocks.updateDescription,
				syncNow: mocks.syncNow,
				reconnect: mocks.reconnect,
				confirmRemovals: mocks.confirmRemovals,
				disconnect: mocks.disconnect,
			},
		},
		integrations: { oauth: { start: mocks.oauthStart } },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documentFolders: {
				list: {
					key: () => ["document-folders"],
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["document-folders", input],
						queryFn: () => mocks.list(input),
					}),
				},
			},
		},
	},
}));

import { DocumentFolderList } from "../DocumentFolderList";

function folder(overrides: Record<string, unknown> = {}) {
	return {
		id: "folder-1",
		provider: "sharepoint",
		name: "Plans",
		drivePath: "/Plans",
		siteName: "Example Team",
		libraryName: "Documents",
		description: "Signed statements of work.",
		connectedAt: new Date("2026-11-01T10:00:00Z"),
		lastReadAt: new Date("2026-11-01T10:05:00Z"),
		reading: false,
		discoveryComplete: true,
		lastListingComplete: true,
		problemCode: null,
		pausedRemovalsCode: null,
		heldRemovalCount: null,
		nextReadAfter: null,
		counts: {
			found: 6,
			imported: 5,
			skipped: 1,
			failed: 0,
			excluded: 0,
			inProgress: 0,
		},
		driveId: "drive-1",
		itemId: "item-1",
		siteId: "site-1",
		webUrl: "https://example.com/sites/team/Plans",
		readerUserId: "user-1",
		readerName: "Dana Example",
		attention: [],
		...overrides,
	};
}

function viewerFolder(overrides: Record<string, unknown> = {}) {
	const {
		driveId: _driveId,
		itemId: _itemId,
		siteId: _siteId,
		webUrl: _webUrl,
		readerUserId: _readerUserId,
		readerName: _readerName,
		attention: _attention,
		...viewer
	} = folder(overrides);
	return viewer;
}

function renderSection(
	props: {
		onConnectedFolderIdsChange?: (folderIds: readonly string[]) => void;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<DocumentFolderList
			projectId="project-1"
			organizationId="org-1"
			{...props}
		/>,
		{ wrapper },
	);
}

async function card(name = "Plans") {
	const heading = await screen.findByRole("heading", { name });
	const item = heading.closest("li");
	if (!item) {
		throw new Error(`No card for ${name}`);
	}
	return within(item);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flag.on = true;
	mocks.list.mockResolvedValue({ view: "editor", folders: [folder()] });
	mocks.syncNow.mockResolvedValue({ syncStarted: true });
	mocks.reconnect.mockResolvedValue({
		folderId: "folder-1",
		importStarted: true,
	});
	mocks.disconnect.mockResolvedValue({ disconnected: true });
	mocks.confirmRemovals.mockResolvedValue({
		status: "confirmed",
		retired: 14,
		syncStarted: true,
	});
});

afterEach(() => {
	cleanup();
});

describe("DocumentFolderList — gating", () => {
	it("renders nothing and reads nothing while the feature is off", () => {
		mocks.flag.on = false;
		const { container } = renderSection();
		expect(container).toBeEmptyDOMElement();
		expect(mocks.list).not.toHaveBeenCalled();
	});

	it("renders nothing when no folder is connected", async () => {
		mocks.list.mockResolvedValue({ view: "editor", folders: [] });
		const { container } = renderSection();
		await waitFor(() => expect(mocks.list).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("tells the page which folders are connected", async () => {
		mocks.list.mockResolvedValue({
			view: "viewer",
			folders: [viewerFolder(), viewerFolder({ id: "folder-2" })],
		});
		const onConnectedFolderIdsChange = vi.fn();
		renderSection({ onConnectedFolderIdsChange });
		await waitFor(() =>
			expect(onConnectedFolderIdsChange).toHaveBeenLastCalledWith([
				"folder-1",
				"folder-2",
			]),
		);
	});
});

describe("DocumentFolderList — the card", () => {
	it("shows place, description, reader, counts and last read time", async () => {
		renderSection();
		const c = await card();
		expect(
			c.getByText("SharePoint · Example Team · Documents · /Plans"),
		).toBeInTheDocument();
		expect(c.getByText("Signed statements of work.")).toBeInTheDocument();
		expect(c.getByText(/Read as Dana Example/)).toBeInTheDocument();
		expect(
			c.getByText("6 found · 5 imported · 1 skipped · 0 failed"),
		).toBeInTheDocument();
		expect(c.getByText(/Last read .* ago/)).toBeInTheDocument();
		expect(c.getByText("Up to date")).toBeInTheDocument();
	});

	it("marks found as so far until a listing completes", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [folder({ reading: true, discoveryComplete: false })],
		});
		renderSection();
		const c = await card();
		expect(
			c.getByText("6 found so far · 5 imported · 1 skipped · 0 failed"),
		).toBeInTheDocument();
	});

	it.each([
		[
			{ reading: true },
			"Reading folder",
			"Files appear in the context list as they are imported.",
		],
		[
			{ lastReadAt: null, discoveryComplete: false },
			"Reading folder",
			"Files appear in the context list as they are imported.",
		],
		[
			{
				counts: {
					found: 6,
					imported: 3,
					skipped: 0,
					failed: 0,
					excluded: 0,
					inProgress: 3,
				},
			},
			"Importing 3 files",
			"Files appear in the context list as they are imported.",
		],
		[
			{ problemCode: "RECONNECT" },
			"Reconnect needed",
			"Fabric can no longer read it with Dana Example's Microsoft connection. Reconnect to read it with yours.",
		],
		[
			{ problemCode: "NO_ACCESS" },
			"No access to this folder in SharePoint",
			"Its reader can no longer open it. Reconnect with an account that can, or disconnect it.",
		],
		[
			{ problemCode: "FOLDER_GONE" },
			"Folder not found in SharePoint",
			"It was moved or deleted. Disconnect it, then connect the folder where it is now.",
		],
		[
			{ problemCode: "SYNC_START_FAILED" },
			"Reading could not start",
			"Use Sync now to try again.",
		],
		[
			{ pausedRemovalsCode: "THROTTLED", nextReadAfter: null },
			"SharePoint asked Fabric to slow down",
			"Removals wait until the next complete read.",
		],
		[
			{ pausedRemovalsCode: "MASS_REMOVAL", heldRemovalCount: 14 },
			"14 files are no longer in the folder",
			"Their context stays until you confirm the removal.",
		],
		[
			{ pausedRemovalsCode: "TOO_LARGE" },
			"Removals paused: the folder holds too many files",
			"Fabric lists at most 5,000 items in a folder. Connect a narrower folder so removals stay in step.",
		],
		[
			{ pausedRemovalsCode: "PARTIAL_READ" },
			"Removals paused: part of the folder could not be read",
			"Removals resume after a complete read.",
		],
		[{}, "Up to date", "Fabric checks the folder again every 30 minutes."],
	])(
		"shows the %o state with its next step",
		async (overrides, label, next) => {
			mocks.list.mockResolvedValue({
				view: "editor",
				folders: [folder(overrides)],
			});
			renderSection();
			const c = await card();
			expect(c.getByText(label)).toBeInTheDocument();
			expect(c.getByText(next)).toBeInTheDocument();
		},
	);

	it("gives the next read time of a throttled folder when there is one", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "THROTTLED",
					nextReadAfter: new Date(Date.now() + 20 * 60_000),
				}),
			],
		});
		renderSection();
		const c = await card();
		expect(
			c.getByText(/^The next read is in 20 minutes\./),
		).toBeInTheDocument();
	});

	it("holds Sync now back while a read runs, and says why", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [folder({ reading: true })],
		});
		renderSection();
		const c = await card();
		const sync = c.getByRole("button", { name: "Sync now" });
		expect(sync).toBeDisabled();
		expect(sync).toHaveAccessibleDescription(
			"A read is running. Sync now is available when it ends.",
		);
	});

	it("syncs now when no read is running", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Sync now" }));
		await waitFor(() =>
			expect(mocks.syncNow).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
			}),
		);
	});

	it("sends one sync while one is starting, from any card", async () => {
		let finishSync: (value: { syncStarted: boolean }) => void = () => {};
		mocks.syncNow.mockReturnValue(
			new Promise((resolve) => {
				finishSync = resolve;
			}),
		);
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [folder(), folder({ id: "folder-2", name: "Notes" })],
		});
		renderSection();
		const plans = await card("Plans");
		const notes = await card("Notes");
		fireEvent.click(plans.getByRole("button", { name: "Sync now" }));
		await waitFor(() =>
			expect(
				notes.getByRole("button", { name: "Sync now" }),
			).toBeDisabled(),
		);
		fireEvent.click(notes.getByRole("button", { name: "Sync now" }));
		fireEvent.click(plans.getByRole("button", { name: "Sync now" }));
		expect(mocks.syncNow).toHaveBeenCalledTimes(1);

		finishSync({ syncStarted: true });
		await waitFor(() =>
			expect(
				notes.getByRole("button", { name: "Sync now" }),
			).toBeEnabled(),
		);
		expect(mocks.syncNow).toHaveBeenCalledTimes(1);
		expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
	});

	it("announces state changes in a polite live region", async () => {
		renderSection();
		await card();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Plans: Up to date",
		);
	});
});

describe("DocumentFolderList — editor actions", () => {
	it("confirms held removals with their count", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 14,
				}),
			],
		});
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Confirm removal" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByRole("heading", { name: "Remove 14 files?" }),
		).toBeInTheDocument();
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Remove files" }),
		);

		await waitFor(() =>
			expect(mocks.confirmRemovals).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folderId: "folder-1",
				expectedCount: 14,
			}),
		);
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"14 files removed from the project.",
			),
		);
	});

	it("asks again with the new count when the folder changed before the removal landed", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 14,
				}),
			],
		});
		mocks.confirmRemovals
			.mockResolvedValueOnce({ status: "stale", heldRemovalCount: 16 })
			.mockResolvedValueOnce({
				status: "confirmed",
				retired: 16,
				syncStarted: true,
			});
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Confirm removal" }));
		const dialog = await screen.findByRole("alertdialog");
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 16,
				}),
			],
		});
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Remove files" }),
		);

		expect(
			await within(dialog).findByText(
				"The folder changed — 16 files are now waiting to be removed.",
			),
		).toBeInTheDocument();
		expect(
			within(dialog).getByRole("heading", { name: "Remove 16 files?" }),
		).toBeInTheDocument();
		expect(mocks.toastSuccess).not.toHaveBeenCalled();

		await waitFor(() =>
			expect(
				within(dialog).getByRole("button", { name: "Remove files" }),
			).toBeEnabled(),
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Remove files" }),
		);
		await waitFor(() =>
			expect(mocks.confirmRemovals).toHaveBeenLastCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folderId: "folder-1",
				expectedCount: 16,
			}),
		);
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"16 files removed from the project.",
			),
		);
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).toBeNull(),
		);
	});

	it("closes and says nothing is waiting when the held files went before the removal landed", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 14,
				}),
			],
		});
		mocks.confirmRemovals.mockResolvedValue({
			status: "stale",
			heldRemovalCount: 0,
		});
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Confirm removal" }));
		const dialog = await screen.findByRole("alertdialog");
		mocks.list.mockResolvedValue({ view: "editor", folders: [folder()] });
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Remove files" }),
		);
		await waitFor(() =>
			expect(mocks.toastInfo).toHaveBeenCalledWith(
				"Nothing is waiting to be removed.",
			),
		);
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).toBeNull(),
		);
	});

	it("edits the description and shows the new text", async () => {
		mocks.updateDescription.mockResolvedValue({
			description: "Contracts only.",
		});
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Edit description" }));

		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getByLabelText("Description");
		expect(field).toHaveValue("Signed statements of work.");
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [folder({ description: "Contracts only." })],
		});
		fireEvent.change(field, { target: { value: "Contracts only." } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mocks.updateDescription).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folderId: "folder-1",
				description: "Contracts only.",
			}),
		);
		expect(await c.findByText("Contracts only.")).toBeInTheDocument();
	});

	it("reopens on the stored description, not a draft that was cancelled", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Edit description" }));
		let dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByLabelText("Description"), {
			target: { value: "A draft nobody saved." },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		fireEvent.click(c.getByRole("button", { name: "Edit description" }));
		dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Description")).toHaveValue(
			"Signed statements of work.",
		);
		expect(mocks.updateDescription).not.toHaveBeenCalled();
	});

	it("opens the same dialogs from the actions menu", async () => {
		const user = userEvent.setup();
		renderSection();
		const c = await card();
		await user.click(c.getByRole("button", { name: "Actions for Plans" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Edit description" }),
		);
		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Describe Plans",
		);
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Cancel",
			}),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		await user.click(c.getByRole("button", { name: "Actions for Plans" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Disconnect" }),
		);
		expect(
			await screen.findByRole("alertdialog", {
				name: "Disconnect Plans?",
			}),
		).toBeInTheDocument();
	});

	it("will not save a description over 500 characters", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Edit description" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByLabelText("Description"), {
			target: { value: "x".repeat(501) },
		});
		expect(within(dialog).getByText("501/500")).toBeInTheDocument();
		expect(
			within(dialog).getByRole("button", { name: "Save" }),
		).toBeDisabled();
	});

	it("returns focus to Edit description when its dialog closes", async () => {
		renderSection();
		const c = await card();
		const edit = c.getByRole("button", { name: "Edit description" });
		edit.focus();
		fireEvent.click(edit);
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(edit).toHaveFocus());
	});

	it("asks before disconnecting, saying the files stay and the description stops applying", async () => {
		renderSection();
		const c = await card();
		const trigger = c.getByRole("button", { name: "Disconnect" });
		trigger.focus();
		fireEvent.click(trigger);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			"Files already imported stay in the project as ordinary context, but this folder's description no longer applies to them.",
		);
		expect(mocks.disconnect).not.toHaveBeenCalled();
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Disconnect" }),
		);
		await waitFor(() =>
			expect(mocks.disconnect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folderId: "folder-1",
			}),
		);
	});

	it("returns focus to Disconnect when its confirmation is cancelled", async () => {
		renderSection();
		const c = await card();
		const trigger = c.getByRole("button", { name: "Disconnect" });
		trigger.focus();
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(mocks.disconnect).not.toHaveBeenCalled();
	});

	it("says the editor becomes the reader before reconnecting", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Reconnect" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("You become this folder's reader");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Reconnect" }),
		);
		await waitFor(() =>
			expect(mocks.reconnect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folderId: "folder-1",
			}),
		);
		expect(mocks.oauthStart).not.toHaveBeenCalled();
	});

	it("connects Microsoft first when the editor has no connection, then reconnects", async () => {
		mocks.reconnect
			.mockRejectedValueOnce(
				new ORPCError("PRECONDITION_FAILED", {
					message: "Connect your Microsoft account.",
					data: { code: "MICROSOFT_NOT_CONNECTED" },
				}),
			)
			.mockResolvedValueOnce({
				folderId: "folder-1",
				importStarted: true,
			});
		mocks.oauthStart.mockResolvedValue({
			authorizationUrl: "https://login.example.com/authorize",
		});
		mocks.openPopup.mockReturnValue({ closed: false });

		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Reconnect" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Reconnect" }),
		);

		await waitFor(() =>
			expect(mocks.oauthStart).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "MICROSOFT_GRAPH",
					organizationId: "org-1",
				}),
			),
		);
		await waitFor(() => expect(mocks.openPopup).toHaveBeenCalled());
		expect(mocks.reconnect).toHaveBeenCalledTimes(1);

		window.dispatchEvent(
			new MessageEvent("message", {
				origin: window.location.origin,
				data: { type: "oauth_success", provider: "Microsoft 365" },
			}),
		);

		await waitFor(() => expect(mocks.reconnect).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Plans reconnected. Reading it now.",
			),
		);
	});

	it("drops the Microsoft connect flow when the section goes away", async () => {
		mocks.reconnect.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "Connect your Microsoft account.",
				data: { code: "MICROSOFT_NOT_CONNECTED" },
			}),
		);
		mocks.oauthStart.mockResolvedValue({
			authorizationUrl: "https://login.example.com/authorize",
		});
		mocks.openPopup.mockReturnValue({ closed: false });
		const removeListener = vi.spyOn(window, "removeEventListener");
		const clearInterval = vi.spyOn(window, "clearInterval");

		const { unmount } = renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Reconnect" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Reconnect" }),
		);
		await waitFor(() => expect(mocks.openPopup).toHaveBeenCalled());

		unmount();
		expect(removeListener).toHaveBeenCalledWith(
			"message",
			expect.any(Function),
		);
		expect(clearInterval).toHaveBeenCalled();
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: window.location.origin,
				data: { type: "oauth_success", provider: "Microsoft 365" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(mocks.reconnect).toHaveBeenCalledTimes(1);
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
		expect(mocks.toastError).not.toHaveBeenCalled();
		expect(mocks.toastWarning).not.toHaveBeenCalled();
		removeListener.mockRestore();
		clearInterval.mockRestore();
	});
});

describe("DocumentFolderList — viewers", () => {
	it("shows place, description, counts and state, with no actions and no reader", async () => {
		mocks.list.mockResolvedValue({
			view: "viewer",
			folders: [viewerFolder({ problemCode: "RECONNECT" })],
		});
		renderSection();
		const c = await card();
		expect(
			c.getByText("SharePoint · Example Team · Documents · /Plans"),
		).toBeInTheDocument();
		expect(c.getByText("Signed statements of work.")).toBeInTheDocument();
		expect(c.getByText("Reconnect needed")).toBeInTheDocument();
		expect(
			c.getByText("A project editor needs to reconnect it."),
		).toBeInTheDocument();
		expect(c.queryByRole("button")).toBeNull();
		expect(c.queryByRole("link")).toBeNull();
		expect(c.queryByText(/Read as/)).toBeNull();
		expect(c.queryByText(/Dana/)).toBeNull();
	});
});

describe("DocumentFolderList — after an action asks for a read", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * The action's own refresh still finds the folder idle, because the sync
	 * has not started its read yet; the read must show within seconds, not at
	 * the next slow poll a minute later.
	 */
	async function expectReadShownWithinSeconds() {
		await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [folder({ reading: true })],
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
		expect((await card()).getByText("Reading folder")).toBeInTheDocument();
	}

	it("shows the read Sync now started within seconds", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Sync now" }));
		await waitFor(() => expect(mocks.syncNow).toHaveBeenCalled());
		await expectReadShownWithinSeconds();
	});

	it("shows the read a reconnect started within seconds", async () => {
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Reconnect" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Reconnect" }),
		);
		await waitFor(() => expect(mocks.reconnect).toHaveBeenCalled());
		await expectReadShownWithinSeconds();
	});

	it("shows the read a confirmed removal started within seconds", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				folder({
					pausedRemovalsCode: "MASS_REMOVAL",
					heldRemovalCount: 14,
				}),
			],
		});
		renderSection();
		const c = await card();
		fireEvent.click(c.getByRole("button", { name: "Confirm removal" }));
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Remove files" }),
		);
		await waitFor(() => expect(mocks.confirmRemovals).toHaveBeenCalled());
		await expectReadShownWithinSeconds();
	});
});
