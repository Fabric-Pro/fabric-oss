/**
 * One Workspace: the page, in the sandboxed viewer, and what is ours around it.
 * The page is read through `fabric_get_frame`, as an agent reads it; the viewer
 * is told the tools the page declared; Fabric Agent opens from this page with
 * the Workspace as its context; and only the author sees the controls that
 * change who can read the page or what it was.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	useFabricToolQuery: vi.fn(),
	openLauncher: vi.fn(),
	registerContext: vi.fn(),
	launcherState: { isOpen: false },
	invalidateQueries: vi.fn(),
	shellProps: [] as Array<Record<string, unknown>>,
	shellMounts: { count: 0 },
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", () => ({
	useFabricToolQuery: mocks.useFabricToolQuery,
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useOptionalFabricAgentLauncher: () => ({
		isOpen: mocks.launcherState.isOpen,
		openLauncher: mocks.openLauncher,
	}),
	useRegisterFabricAgentContext: mocks.registerContext,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
	};
});

vi.mock("@saas/frames/components/FrameVizShell", async () => {
	const { useEffect } = await import("react");
	return {
		FrameVizShell: (props: Record<string, unknown>) => {
			mocks.shellProps.push(props);
			useEffect(() => {
				mocks.shellMounts.count += 1;
			}, []);
			return <div data-testid="frame-shell">{String(props.title)}</div>;
		},
	};
});

vi.mock("../WorkspaceHistorySheet", () => ({
	WorkspaceHistorySheet: (props: {
		frameId: string;
		open: boolean;
		onRestored: () => void;
	}) =>
		props.open ? (
			<div data-testid="history-sheet" data-frame-id={props.frameId}>
				<button type="button" onClick={props.onRestored}>
					restored
				</button>
			</div>
		) : null,
}));

vi.mock("../WorkspaceComments", () => ({
	WorkspaceComments: (props: { frameId: string; organizationId: string }) => (
		<div
			data-testid="comments"
			data-frame-id={props.frameId}
			data-organization-id={props.organizationId}
		/>
	),
}));

vi.mock("../WorkspaceDeleteMenu", () => ({
	WorkspaceDeleteMenu: (props: {
		frameId: string;
		title: string;
		organizationId: string;
		organizationSlug: string;
	}) => (
		<div
			data-testid="delete-menu"
			data-frame-id={props.frameId}
			data-title={props.title}
			data-organization-id={props.organizationId}
			data-organization-slug={props.organizationSlug}
		/>
	),
}));

vi.mock("../WorkspaceCopyButton", () => ({
	WorkspaceCopyButton: (props: {
		frameId: string;
		organizationId: string;
		organizationSlug: string;
		runtimeTools: readonly string[];
	}) => (
		<div
			data-testid="copy-button"
			data-frame-id={props.frameId}
			data-organization-id={props.organizationId}
			data-organization-slug={props.organizationSlug}
			data-tools={props.runtimeTools.join(",")}
		/>
	),
}));

import { FrameDetailSchema } from "@saas/frames/lib/frame-tool-types";
import { WorkspacePage } from "../WorkspacePage";

const frame = {
	frameId: "frame-1",
	title: "Delivery status",
	description: "Open work by status.",
	kind: "frame",
	surface: "workspace",
	projectId: "project-1",
	shareScope: "WORKSPACE_AND_EMAILS",
	ownedByCaller: true,
	blocks: [{ id: "page", type: "html", content: "<p>page</p>" }],
	runtimeTools: ["fabric_list_workflows"],
	updatedAt: "2026-10-14T09:00:00.000Z",
};

type QueryState = {
	data?: unknown;
	isLoading?: boolean;
	isError?: boolean;
};

function answerWith(state: QueryState) {
	const calls: Array<{ name: string; args: unknown; options: unknown }> = [];
	mocks.useFabricToolQuery.mockImplementation(
		(name: string, args: unknown, options: unknown) => {
			calls.push({ name, args, options });
			return {
				data: undefined,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
				...state,
			};
		},
	);
	return calls;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.shellProps.length = 0;
	mocks.shellMounts.count = 0;
	mocks.launcherState.isOpen = false;
});

const renderPage = () =>
	render(
		<WorkspacePage
			frameId="frame-1"
			organizationId="org-1"
			organizationSlug="example-org"
		/>,
	);

describe("a Workspace page", () => {
	it("reads the page through the get tool", () => {
		const calls = answerWith({ data: frame });

		renderPage();

		expect(calls[0]).toMatchObject({
			name: "fabric_get_frame",
			args: { frameId: "frame-1" },
		});
	});

	it("registers the Workspace as where the user is, with its project, while it is open", () => {
		answerWith({ data: frame });

		renderPage();

		expect(mocks.registerContext).toHaveBeenLastCalledWith({
			surface: "workspace",
			launchFrameId: "frame-1",
			workspaceId: "frame-1",
			projectId: "project-1",
		});
	});

	it("registers the Workspace before the page has loaded, without a project", () => {
		answerWith({ isLoading: true });

		renderPage();

		expect(mocks.registerContext).toHaveBeenLastCalledWith({
			surface: "workspace",
			launchFrameId: "frame-1",
			workspaceId: "frame-1",
			projectId: null,
		});
	});

	it("shows the page in the viewer with the tools it declared, inside the organization's routes", () => {
		answerWith({ data: frame });

		renderPage();

		expect(screen.getByTestId("frame-shell")).toHaveTextContent(
			"Delivery status",
		);
		expect(mocks.shellProps.at(-1)).toMatchObject({
			surface: "workspace",
			frameId: "frame-1",
			embedUrl: "/app/example-org/frames/frame-1/embed",
			runtimeTools: ["fabric_list_workflows"],
			organizationId: "org-1",
			isProjectFrame: true,
			frameDocument: {
				title: "Delivery status",
				blocks: [{ id: "page", type: "html" }],
			},
		});
	});

	it("links back to the list", () => {
		answerWith({ data: frame });

		renderPage();

		expect(
			screen.getByRole("link", { name: /All workspaces/ }),
		).toHaveAttribute("href", "/app/example-org/workspaces");
	});

	it("opens Fabric Agent on this Workspace, with a draft to finish, from the button and from the page's own script", () => {
		answerWith({ data: frame });

		renderPage();
		fireEvent.click(
			screen.getByRole("button", { name: "Ask Fabric Agent" }),
		);
		(
			mocks.shellProps.at(-1) as { onOpenAgent: (p: string) => void }
		).onOpenAgent("Explain this chart");

		const context = {
			surface: "workspace",
			launchFrameId: "frame-1",
			workspaceId: "frame-1",
			projectId: "project-1",
		};
		expect(mocks.openLauncher).toHaveBeenNthCalledWith(1, {
			...context,
			prompt: expect.stringContaining("Change this workspace"),
		});
		expect(mocks.openLauncher).toHaveBeenNthCalledWith(2, {
			...context,
			prompt: "Explain this chart",
		});
	});

	it("shows a loading state and then an error when the page is gone", () => {
		answerWith({ isLoading: true });
		const loading = renderPage();
		expect(
			screen.getByRole("status", { name: "Loading workspace" }),
		).toBeInTheDocument();
		loading.unmount();

		answerWith({ isError: true });
		renderPage();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"This workspace is no longer available.",
		);
		expect(screen.queryByTestId("frame-shell")).toBeNull();
	});

	it("says who the Workspace is shared with", () => {
		answerWith({ data: frame });

		renderPage();

		expect(screen.getByTestId("workspace-sharing")).toHaveTextContent(
			"Shared with everyone in your organization.",
		);
	});

	it("shows inherited project access for a PRIVATE Workspace to its author and a reader", () => {
		answerWith({ data: { ...frame, shareScope: "PRIVATE" } });
		const author = renderPage();
		expect(screen.getByTestId("workspace-sharing")).toHaveTextContent(
			"Open to its owner and accepted project members.",
		);
		expect(screen.getByTestId("workspace-sharing")).not.toHaveTextContent(
			"only you can open it",
		);
		author.unmount();

		answerWith({
			data: { ...frame, shareScope: "PRIVATE", ownedByCaller: false },
		});
		renderPage();
		expect(screen.getByTestId("workspace-sharing")).toHaveTextContent(
			"Open to its owner and accepted project members.",
		);
	});

	it("keeps owner-only wording for a standalone PRIVATE Workspace", () => {
		answerWith({
			data: { ...frame, projectId: undefined, shareScope: "PRIVATE" },
		});
		renderPage();
		expect(screen.getByTestId("workspace-sharing")).toHaveTextContent(
			"Private: only you can open it.",
		);
		expect(screen.getByTestId("workspace-sharing")).not.toHaveTextContent(
			"project members",
		);
	});
});

describe("who can change a Workspace", () => {
	it("gives its author the history control, and the viewer's one Share control", () => {
		answerWith({ data: frame });

		renderPage();

		expect(mocks.shellProps.at(-1)).toMatchObject({
			canManageSharing: true,
		});
		expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Version history" }),
		);
		expect(screen.getByTestId("history-sheet")).toHaveAttribute(
			"data-frame-id",
			"frame-1",
		);
	});

	it("keeps both from a reader who is not its author", () => {
		answerWith({ data: { ...frame, ownedByCaller: false } });

		renderPage();

		expect(mocks.shellProps.at(-1)).toMatchObject({
			canManageSharing: false,
		});
		expect(
			screen.queryByRole("button", { name: "Version history" }),
		).toBeNull();
		expect(screen.getByTestId("frame-shell")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Ask Fabric Agent" }),
		).toBeInTheDocument();
	});

	it("reloads the page after the share sheet closes and after a version is restored", () => {
		answerWith({ data: frame });

		renderPage();
		(
			mocks.shellProps.at(-1) as { onSharingChanged: () => void }
		).onSharingChanged();
		expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);

		fireEvent.click(
			screen.getByRole("button", { name: "Version history" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "restored" }));
		expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
		expect(mocks.invalidateQueries).toHaveBeenLastCalledWith({
			queryKey: ["fabric-tool"],
		});
		expect(screen.queryByTestId("history-sheet")).toBeNull();
	});
});

describe("what people can do with a Workspace they can open", () => {
	it("shows the comments of the page, to its author and to a reader alike", () => {
		answerWith({ data: frame });
		const author = renderPage();
		expect(screen.getByTestId("comments")).toHaveAttribute(
			"data-frame-id",
			"frame-1",
		);
		expect(screen.getByTestId("comments")).toHaveAttribute(
			"data-organization-id",
			"org-1",
		);
		author.unmount();

		answerWith({ data: { ...frame, ownedByCaller: false } });
		renderPage();

		expect(screen.getByTestId("comments")).toBeInTheDocument();
	});

	it("shows no comments before the page has loaded, or when it is gone", () => {
		answerWith({ isLoading: true });
		const loading = renderPage();
		expect(screen.queryByTestId("comments")).toBeNull();
		loading.unmount();

		answerWith({ isError: true });
		renderPage();

		expect(screen.queryByTestId("comments")).toBeNull();
	});

	it("offers a copy to its author and to a reader, carrying the tools the page declared", () => {
		answerWith({ data: frame });
		const author = renderPage();
		expect(screen.getByTestId("copy-button")).toHaveAttribute(
			"data-tools",
			"fabric_list_workflows",
		);
		expect(screen.getByTestId("copy-button")).toHaveAttribute(
			"data-organization-slug",
			"example-org",
		);
		author.unmount();

		answerWith({ data: { ...frame, ownedByCaller: false } });
		renderPage();

		expect(screen.getByTestId("copy-button")).toHaveAttribute(
			"data-frame-id",
			"frame-1",
		);
	});

	it("offers its author the deletion of the page, with the page named", () => {
		answerWith({ data: frame });

		renderPage();

		expect(screen.getByTestId("delete-menu")).toHaveAttribute(
			"data-frame-id",
			"frame-1",
		);
		expect(screen.getByTestId("delete-menu")).toHaveAttribute(
			"data-title",
			"Delivery status",
		);
		expect(screen.getByTestId("delete-menu")).toHaveAttribute(
			"data-organization-slug",
			"example-org",
		);
	});

	it("offers a reader who is not its author no deletion, and none before the page has loaded", () => {
		answerWith({ data: { ...frame, ownedByCaller: false } });
		const reader = renderPage();
		expect(screen.queryByTestId("delete-menu")).toBeNull();
		reader.unmount();

		answerWith({ isLoading: true });
		renderPage();

		expect(screen.queryByTestId("delete-menu")).toBeNull();
	});

	it("offers no copy until the page has loaded", () => {
		answerWith({ isLoading: true });

		renderPage();

		expect(screen.queryByTestId("copy-button")).toBeNull();
	});
});

describe("keeping the page current", () => {
	it("does not poll while Fabric Agent is closed", () => {
		const calls = answerWith({ data: frame });

		renderPage();

		expect(calls[0].options).toEqual({
			schema: FrameDetailSchema,
			refetchInterval: false,
		});
	});

	it("checks for a change often while Fabric Agent is open, so the agent's edit shows", () => {
		mocks.launcherState.isOpen = true;
		const calls = answerWith({ data: frame });

		renderPage();

		expect(calls[0].options).toEqual({
			schema: FrameDetailSchema,
			refetchInterval: 5000,
		});
	});

	it("reloads the viewer when the page's content changes, and not when it is read again unchanged", () => {
		const page = () => (
			<WorkspacePage
				frameId="frame-1"
				organizationId="org-1"
				organizationSlug="example-org"
			/>
		);
		answerWith({ data: frame });
		const view = render(page());
		expect(mocks.shellMounts.count).toBe(1);

		answerWith({ data: { ...frame } });
		view.rerender(page());
		expect(mocks.shellMounts.count).toBe(1);

		answerWith({
			data: { ...frame, updatedAt: "2026-10-14T10:00:00.000Z" },
		});
		view.rerender(page());
		expect(mocks.shellMounts.count).toBe(2);
		expect(screen.getAllByTestId("frame-shell")).toHaveLength(1);
	});
});
