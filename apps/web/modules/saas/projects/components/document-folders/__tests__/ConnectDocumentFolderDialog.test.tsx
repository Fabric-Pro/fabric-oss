/**
 * @vitest-environment jsdom
 */

/**
 * Choosing OneDrive and SharePoint document folders (Fizzy #2808).
 *
 * Pinned: SharePoint sites come from search and from followed sites, and a
 * failed followed-sites read leaves search usable; a library opens through
 * the breadcrumb; folders from OneDrive and SharePoint are chosen together;
 * a folder inside or holding a selected or connected one cannot be chosen,
 * and says why; a personal account is told SharePoint is unavailable; a
 * description over 500 characters cannot be sent; a refused connect names
 * the folder in the way; the folder tree works from the keyboard; a folder
 * just connected shows as being read.
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
import { type ReactNode, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	browse: vi.fn(),
	list: vi.fn(),
	connect: vi.fn(),
	toastSuccess: vi.fn(),
	toastWarning: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: mocks.toastSuccess,
		warning: mocks.toastWarning,
		error: mocks.toastError,
		info: vi.fn(),
	},
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "CLOUD_DRIVE_FOLDERS",
}));

vi.mock("@shared/lib/oauth-popup", () => ({
	openOAuthPopup: vi.fn(),
	POPUP_BLOCKED_MESSAGE: "Popup blocked",
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { documentFolders: { connect: mocks.connect } },
		integrations: { oauth: { start: vi.fn() } },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documentFolders: {
				browse: {
					queryOptions: ({
						input,
					}: {
						input: { level: unknown };
					}) => ({
						queryKey: ["browse", input],
						queryFn: () => mocks.browse(input.level),
					}),
				},
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

import { ConnectDocumentFolderDialog } from "../ConnectDocumentFolderDialog";
import { DocumentFolderList } from "../DocumentFolderList";

type Level =
	| { kind: "roots" }
	| { kind: "sites"; search: string }
	| { kind: "drives"; siteId: string }
	| { kind: "folders"; driveId?: string; itemId?: string };

function folderItem(driveId: string, itemId: string, name: string) {
	return { driveId, itemId, name, childCount: 2, webUrl: null };
}

const ROOTS = {
	level: "roots",
	oneDrive: { status: "available" },
	sharePoint: {
		status: "available",
		followedSites: [
			{ siteId: "site-1", name: "Example Team", webUrl: null },
		],
	},
};

function browseFor(level: Level) {
	switch (level.kind) {
		case "roots":
			return ROOTS;
		case "sites":
			return {
				level: "sites",
				status: "available",
				sites: [
					{ siteId: "site-2", name: "Project Hub", webUrl: null },
				],
			};
		case "drives":
			return {
				level: "drives",
				siteId: level.siteId,
				status: "available",
				libraries: [
					{
						driveId: level.siteId === "site-2" ? "lib-2" : "lib-1",
						name: "Documents",
						webUrl: null,
					},
				],
			};
		case "folders": {
			const key = `${level.driveId ?? ""}/${level.itemId ?? ""}`;
			const children: Record<string, ReturnType<typeof folderItem>[]> = {
				"/": [
					folderItem("od-1", "od-plans", "Plans"),
					folderItem("od-1", "od-notes", "Notes"),
				],
				"od-1/od-plans": [folderItem("od-1", "od-2026", "2026")],
				"lib-1/": [folderItem("lib-1", "sp-contracts", "Contracts")],
				"lib-2/": [folderItem("lib-2", "hub-specs", "Specs")],
			};
			return {
				level: "folders",
				driveId: level.driveId ?? null,
				itemId: level.itemId ?? (level.driveId ? "root" : null),
				folders: children[key] ?? [],
				supportedFileCount: 3,
				truncated: false,
			};
		}
	}
}

function connectedFolder(overrides: Record<string, unknown> = {}) {
	return {
		id: "folder-1",
		provider: "onedrive",
		name: "Plans",
		drivePath: "/Plans",
		siteName: null,
		libraryName: null,
		description: null,
		connectedAt: new Date("2026-11-01T10:00:00Z"),
		lastReadAt: null,
		reading: false,
		discoveryComplete: false,
		lastListingComplete: false,
		problemCode: null,
		pausedRemovalsCode: null,
		heldRemovalCount: null,
		nextReadAfter: null,
		counts: {
			found: 0,
			imported: 0,
			skipped: 0,
			failed: 0,
			excluded: 0,
			inProgress: 0,
		},
		driveId: "od-1",
		itemId: "od-plans",
		siteId: null,
		webUrl: null,
		readerUserId: "user-1",
		readerName: "Dana Example",
		attention: [],
		...overrides,
	};
}

function client() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDialog(onOpenChange = vi.fn()) {
	const queryClient = client();
	render(
		<QueryClientProvider client={queryClient}>
			<ConnectDocumentFolderDialog
				projectId="project-1"
				organizationId="org-1"
				open
				onOpenChange={onOpenChange}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange };
}

function tree() {
	return screen.findByRole("tree");
}

async function openPlace(name: "My OneDrive" | "SharePoint") {
	fireEvent.click(await screen.findByRole("button", { name }));
}

async function treeItem(name: string) {
	return within(await tree()).findByRole("treeitem", { name });
}

function press(element: HTMLElement, key: string) {
	fireEvent.keyDown(element, { key });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.browse.mockImplementation(async (level: Level) => browseFor(level));
	mocks.list.mockResolvedValue({ view: "editor", folders: [] });
	mocks.connect.mockResolvedValue({
		folders: [{ folderId: "folder-9", name: "Notes", reconnected: false }],
		importStarted: true,
	});
});

afterEach(() => {
	cleanup();
});

describe("ConnectDocumentFolderDialog — places", () => {
	it("says what is read and that the files become visible to the whole project", async () => {
		renderDialog();
		await screen.findByRole("button", { name: "My OneDrive" });
		const disclosure = screen.getByText(/subfolders down to 5 levels/);
		expect(disclosure).toHaveTextContent(
			"the 500 most recently modified supported files",
		);
		expect(disclosure).toHaveTextContent(/PDF/);
		expect(disclosure).toHaveTextContent(
			"visible to everyone with access to this project",
		);
		expect(screen.getByRole("button", { name: /^Connect/ })).toBeDisabled();
	});

	it("tells a personal account that SharePoint is unavailable", async () => {
		mocks.browse.mockImplementation(async (level: Level) =>
			level.kind === "roots"
				? { ...ROOTS, sharePoint: { status: "unavailable" } }
				: browseFor(level),
		);
		renderDialog();
		expect(
			await screen.findByText(
				"SharePoint is not available for this Microsoft account. Personal accounts have OneDrive only.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "SharePoint" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "My OneDrive" }),
		).toBeInTheDocument();
	});

	it("says what to do without a Microsoft connection", async () => {
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

describe("ConnectDocumentFolderDialog — SharePoint", () => {
	it("lists followed sites and search results, and opens a library through the breadcrumb", async () => {
		renderDialog();
		await openPlace("SharePoint");

		expect(
			await screen.findByRole("button", { name: "Example Team" }),
		).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Search SharePoint sites"), {
			target: { value: "hub" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Project Hub" }),
		);
		await waitFor(() =>
			expect(mocks.browse).toHaveBeenCalledWith({
				kind: "sites",
				search: "hub",
			}),
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Documents" }),
		);
		expect(await treeItem("Specs")).toBeInTheDocument();

		const path = screen.getByRole("navigation", { name: "Folder path" });
		expect(within(path).getByText("Documents")).toHaveAttribute(
			"aria-current",
			"page",
		);
		fireEvent.click(
			within(path).getByRole("button", { name: "SharePoint" }),
		);
		expect(
			await screen.findByRole("button", { name: "Example Team" }),
		).toBeInTheDocument();
	});

	it("keeps search usable when followed sites could not be read", async () => {
		mocks.browse.mockImplementation(async (level: Level) =>
			level.kind === "roots"
				? { ...ROOTS, sharePoint: { status: "error" } }
				: browseFor(level),
		);
		renderDialog();
		await openPlace("SharePoint");

		expect(
			await screen.findByText(
				"Your followed sites could not be read. Search for a site instead.",
			),
		).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search SharePoint sites"), {
			target: { value: "hub" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(
			await screen.findByRole("button", { name: "Project Hub" }),
		).toBeInTheDocument();
	});
});

describe("ConnectDocumentFolderDialog — choosing folders", () => {
	it("connects OneDrive and SharePoint folders together, each with its description", async () => {
		const { onOpenChange } = renderDialog();
		await openPlace("My OneDrive");
		press(await treeItem("Notes"), " ");
		expect(await treeItem("Notes")).toHaveAttribute("aria-checked", "true");

		const path = screen.getByRole("navigation", { name: "Folder path" });
		fireEvent.click(within(path).getByRole("button", { name: "Places" }));
		await openPlace("SharePoint");
		fireEvent.click(
			await screen.findByRole("button", { name: "Example Team" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Documents" }),
		);
		press(await treeItem("Contracts"), " ");

		expect(screen.getByRole("status")).toHaveTextContent(
			"2 folders selected",
		);
		fireEvent.change(
			screen.getByLabelText("Description for Contracts (optional)"),
			{ target: { value: "  Signed contracts only.  " } },
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Connect 2 folders" }),
		);

		await waitFor(() =>
			expect(mocks.connect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folders: [
					{ driveId: "od-1", itemId: "od-notes" },
					{
						driveId: "lib-1",
						itemId: "sp-contracts",
						siteId: "site-1",
						siteName: "Example Team",
						description: "Signed contracts only.",
					},
				],
			}),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(mocks.toastSuccess).toHaveBeenCalled();
	});

	it("connects a whole SharePoint library by its root, through its site", async () => {
		renderDialog();
		await openPlace("SharePoint");
		fireEvent.click(
			await screen.findByRole("button", { name: "Example Team" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Documents" }),
		);
		fireEvent.click(
			await screen.findByRole("checkbox", {
				name: "Use the whole Documents library",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect folder" }));

		await waitFor(() =>
			expect(mocks.connect).toHaveBeenCalledWith({
				projectId: "project-1",
				organizationId: "org-1",
				folders: [
					{
						driveId: "lib-1",
						itemId: "root",
						siteId: "site-1",
						siteName: "Example Team",
					},
				],
			}),
		);
	});

	it("does not offer My OneDrive's root as a whole", async () => {
		renderDialog();
		await openPlace("My OneDrive");
		await treeItem("Plans");
		expect(screen.queryByRole("checkbox", { name: /^Use / })).toBeNull();
	});

	it("disables a folder inside or holding a selected one, and says why", async () => {
		renderDialog();
		await openPlace("My OneDrive");
		press(await treeItem("Plans"), "Enter");
		const year = await treeItem("2026");
		press(year, " ");
		expect(year).toHaveAttribute("aria-checked", "true");

		const path = screen.getByRole("navigation", { name: "Folder path" });
		fireEvent.click(
			within(path).getByRole("button", { name: "My OneDrive" }),
		);
		const plans = await treeItem("Plans");
		expect(plans).toHaveAttribute("aria-disabled", "true");
		expect(plans).toHaveAccessibleDescription(
			/Holds "2026", which you selected/,
		);
		press(plans, " ");
		expect(plans).toHaveAttribute("aria-checked", "false");
		expect(await treeItem("Notes")).not.toHaveAttribute("aria-disabled");
	});

	it("disables a connected folder and the folders inside it", async () => {
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [connectedFolder()],
		});
		renderDialog();
		await openPlace("My OneDrive");
		const plans = await treeItem("Plans");
		await waitFor(() =>
			expect(plans).toHaveAccessibleDescription(/Already connected/),
		);
		expect(plans).toHaveAttribute("aria-disabled", "true");

		press(plans, "Enter");
		const year = await treeItem("2026");
		expect(year).toHaveAttribute("aria-disabled", "true");
		expect(year).toHaveAccessibleDescription(
			/Inside "Plans", which is already connected/,
		);
	});

	it("will not send a description over 500 characters", async () => {
		renderDialog();
		await openPlace("My OneDrive");
		press(await treeItem("Notes"), " ");
		fireEvent.change(
			screen.getByLabelText("Description for Notes (optional)"),
			{ target: { value: "x".repeat(501) } },
		);
		expect(screen.getByText("501/500")).toBeInTheDocument();
		const connect = screen.getByRole("button", { name: "Connect folder" });
		expect(connect).toBeDisabled();
		expect(connect).toHaveAccessibleDescription(
			"Descriptions can be at most 500 characters.",
		);
	});

	it("cannot be cancelled while a connect is on its way, and closes when it lands", async () => {
		let finishConnect: (value: unknown) => void = () => {};
		mocks.connect.mockReturnValue(
			new Promise((resolve) => {
				finishConnect = resolve;
			}),
		);
		const { onOpenChange } = renderDialog();
		await openPlace("My OneDrive");
		press(await treeItem("Notes"), " ");
		fireEvent.click(screen.getByRole("button", { name: "Connect folder" }));
		await waitFor(() => expect(mocks.connect).toHaveBeenCalled());

		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(cancel).toBeDisabled();
		fireEvent.click(cancel);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		finishConnect({
			folders: [
				{ folderId: "folder-9", name: "Notes", reconnected: false },
			],
			importStarted: true,
		});
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(mocks.toastSuccess).toHaveBeenCalled();
	});

	it("shows a refused connect, naming the folder in the way", async () => {
		mocks.connect.mockRejectedValue(
			new ORPCError("CONFLICT", {
				message:
					'"Notes" holds or lies inside the meeting transcript folder "Standups". Choose a folder that does not overlap it.',
				data: {
					code: "OVERLAPS_TRANSCRIPT_FOLDER",
					folderName: "Notes",
					existingFolderName: "Standups",
				},
			}),
		);
		const { onOpenChange } = renderDialog();
		await openPlace("My OneDrive");
		press(await treeItem("Notes"), " ");
		fireEvent.click(screen.getByRole("button", { name: "Connect folder" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			'meeting transcript folder "Standups"',
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});
});

describe("ConnectDocumentFolderDialog — keyboard", () => {
	it("moves through the tree with the arrow keys, selects with Space and opens with Enter", async () => {
		renderDialog();
		await openPlace("My OneDrive");
		const plans = await treeItem("Plans");
		const notes = await treeItem("Notes");
		expect(plans).toHaveAttribute("tabindex", "0");
		expect(notes).toHaveAttribute("tabindex", "-1");

		plans.focus();
		press(plans, "ArrowDown");
		expect(notes).toHaveFocus();
		expect(notes).toHaveAttribute("tabindex", "0");
		press(notes, "Home");
		expect(plans).toHaveFocus();

		press(plans, " ");
		expect(plans).toHaveAttribute("aria-checked", "true");
		press(plans, " ");
		expect(plans).toHaveAttribute("aria-checked", "false");

		press(plans, "Enter");
		await waitFor(async () => expect(await treeItem("2026")).toHaveFocus());
		press(await treeItem("2026"), "ArrowLeft");
		await waitFor(async () =>
			expect(await treeItem("Plans")).toHaveFocus(),
		);
	});

	it("returns focus to its opener when it closes", async () => {
		function Harness() {
			const [open, setOpen] = useState(false);
			const opener = useRef<HTMLButtonElement>(null);
			return (
				<>
					<button
						ref={opener}
						type="button"
						onClick={() => setOpen(true)}
					>
						Choose folders
					</button>
					{open && (
						<ConnectDocumentFolderDialog
							projectId="project-1"
							organizationId="org-1"
							open
							onOpenChange={setOpen}
							returnFocusTo={opener}
						/>
					)}
				</>
			);
		}
		render(
			<QueryClientProvider client={client()}>
				<Harness />
			</QueryClientProvider>,
		);
		const opener = screen.getByRole("button", { name: "Choose folders" });
		opener.focus();
		fireEvent.click(opener);
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(opener).toHaveFocus());
	});
});

describe("ConnectDocumentFolderDialog — after connecting", () => {
	it("shows the new folder as being read as soon as connect returns", async () => {
		const queryClient = client();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);
		function Harness() {
			const [open, setOpen] = useState(true);
			return (
				<>
					<DocumentFolderList
						projectId="project-1"
						organizationId="org-1"
					/>
					{open && (
						<ConnectDocumentFolderDialog
							projectId="project-1"
							organizationId="org-1"
							open
							onOpenChange={setOpen}
						/>
					)}
				</>
			);
		}
		render(<Harness />, { wrapper });
		await openPlace("My OneDrive");
		press(await treeItem("Notes"), " ");
		mocks.list.mockResolvedValue({
			view: "editor",
			folders: [
				connectedFolder({
					id: "folder-9",
					name: "Notes",
					drivePath: "/Notes",
					itemId: "od-notes",
				}),
			],
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect folder" }));

		const heading = await screen.findByRole("heading", { name: "Notes" });
		const card = within(heading.closest("li") as HTMLElement);
		expect(card.getByText("Reading folder")).toBeInTheDocument();
	});
});
