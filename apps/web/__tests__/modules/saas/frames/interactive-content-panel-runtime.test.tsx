import { InteractiveContentPanel } from "@saas/agents/components/FabricChat/shared/InteractiveContentPanel";
import { FrameViewer } from "@saas/frames/components/FrameViewer";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	listTools: vi.fn(),
	callTool: vi.fn(),
	viewing: { id: "org-a" as string | null },
	user: { id: "user-a" as string | null },
	invalidateQueries: vi.fn(),
	publish: vi.fn(),
	revokeShare: vi.fn(),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: mocks.user.id ? { id: mocks.user.id } : null,
	}),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: mocks.query,
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		frames: {
			get: vi.fn(),
			publish: mocks.publish,
			revokeShare: mocks.revokeShare,
		},
	},
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useParams: () => ({ organizationSlug: "example-org" }),
}));
vi.mock("@saas/frames/hooks/use-open-frame-agent", () => ({
	useOpenFrameAgent: () => vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => mocks.viewing.id,
	useOrganizationSlug: () => "example-org",
}));
vi.mock("@saas/mcp/lib/fabric-tool-client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/fabric-tool-client")
	>()),
	listFabricTools: mocks.listTools,
	callFabricTool: mocks.callTool,
}));
vi.mock("@saas/frames/components/ShareFrameSheet", () => ({
	ShareFrameSheet: ({
		open,
		onOpenChange,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}) =>
		open ? (
			<div role="dialog" aria-label="Frame sharing">
				<button type="button" onClick={() => onOpenChange(false)}>
					Close sharing
				</button>
			</div>
		) : null,
}));
vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@ui/components/sheet", () => {
	const Pass = ({ children }: { children?: ReactNode }) => (
		<div>{children}</div>
	);
	return {
		Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) =>
			open ? <div>{children}</div> : null,
		SheetContent: Pass,
		SheetHeader: Pass,
		SheetTitle: Pass,
	};
});

const TOOLS = [
	"fabric_get_project_pm_connection",
	"fabric_list_project_pm_members",
	"fabric_get_project_work_item_counts",
];
const saved = {
	id: "frame-1",
	userId: "user-a",
	organizationId: "org-a",
	projectId: "project-1",
	surface: "workspace",
	title: "Project dashboard",
	kind: "frame",
	sourceRunType: "direct-chat",
	updatedAt: "2026-10-19T10:00:00Z",
	runtimeTools: TOOLS,
	document: {
		version: 1,
		kind: "frame",
		title: "Project dashboard",
		blocks: [
			{ id: "dashboard", type: "html", content: "<p>Dashboard</p>" },
		],
	},
};
const modelResult = {
	frameId: "frame-1",
	embedUrl: "https://untrusted.example/preview",
	frameUrl: "https://untrusted.example/page",
};

function panel(frameId = "frame-1") {
	return (
		<InteractiveContentPanel
			frame={{ ...modelResult, frameId }}
			organizationId="org-a"
			onClose={vi.fn()}
		/>
	);
}

function call(
	iframe: HTMLIFrameElement,
	name: string,
	requestId = "read",
	args: Record<string, unknown> = { projectId: "project-1" },
) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: window.location.origin,
				source: iframe.contentWindow,
				data: {
					type: "fabric-frame:call",
					requestId,
					name,
					args,
				},
			}),
		);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.viewing.id = "org-a";
	mocks.user.id = "user-a";
	mocks.query.mockReturnValue({ isSuccess: true, data: saved });
	mocks.listTools.mockResolvedValue(
		TOOLS.map((name) => ({ name, annotations: { readOnlyHint: true } })),
	);
	mocks.callTool.mockResolvedValue({ status: "ready" });
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("saved artifact runtime authority", () => {
	it("opens the owner's sharing sheet without publishing or revoking access", () => {
		render(<FrameViewer frameId="frame-1" organizationId="org-a" />);
		expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Share" }));

		expect(
			screen.getByRole("dialog", { name: "Frame sharing" }),
		).toBeInTheDocument();
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.revokeShare).not.toHaveBeenCalled();
		expect(mocks.invalidateQueries).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Close sharing" }));

		expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
		expect(mocks.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["frame", "frame-1", "org-a"],
		});
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.revokeShare).not.toHaveBeenCalled();
	});

	it.each(["other-user", null])(
		"offers no sharing management to a non-owner session: %s",
		(userId) => {
			mocks.user.id = userId;
			const view = render(
				<FrameViewer frameId="frame-1" organizationId="org-a" />,
			);

			expect(view.container.querySelector("iframe")).not.toBeNull();
			expect(
				screen.queryByRole("button", { name: /^(share|publish)/i }),
			).toBeNull();
			expect(screen.queryByRole("dialog")).toBeNull();
			expect(mocks.publish).not.toHaveBeenCalled();
			expect(mocks.revokeShare).not.toHaveBeenCalled();
		},
	);

	it("removes sharing management when the session is no longer the owner", () => {
		const view = render(
			<FrameViewer frameId="frame-1" organizationId="org-a" />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(
			screen.getByRole("dialog", { name: "Frame sharing" }),
		).toBeInTheDocument();

		mocks.user.id = "other-user";
		view.rerender(<FrameViewer frameId="frame-1" organizationId="org-a" />);

		expect(view.container.querySelector("iframe")).not.toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /^(share|publish)/i }),
		).toBeNull();
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.revokeShare).not.toHaveBeenCalled();
	});

	it("runs a consented synthetic write for the authorized saved artifact", async () => {
		mocks.query.mockReturnValue({
			isSuccess: true,
			data: {
				...saved,
				surface: "artifact",
				runtimeTools: ["fabric_page_data_set"],
			},
		});
		mocks.listTools.mockResolvedValue([{ name: "fabric_page_data_set" }]);
		const view = render(
			<FrameViewer frameId="frame-1" organizationId="org-a" />,
		);
		const iframe = view.container.querySelector("iframe");
		if (!iframe) {
			throw new Error("Expected the saved artifact iframe");
		}
		const args = {
			collection: "example-qa",
			records: [{ key: "smoke", value: { message: "synthetic" } }],
		};
		call(iframe, "fabric_page_data_set", "save", args);
		await screen.findByRole("alertdialog");
		expect(mocks.callTool).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
		expect(mocks.callTool).toHaveBeenCalledWith(
			"fabric_page_data_set",
			{ ...args, frameId: "frame-1" },
			{ organizationId: "org-a", pageFrameId: "frame-1" },
		);
	});

	it("drops cached artifact authority after a failed read", () => {
		const view = render(
			<FrameViewer frameId="frame-1" organizationId="org-a" />,
		);
		expect(view.container.querySelector("iframe")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(
			screen.getByRole("dialog", { name: "Frame sharing" }),
		).toBeInTheDocument();
		mocks.query.mockReturnValue({ isError: true, data: saved });
		view.rerender(<FrameViewer frameId="frame-1" organizationId="org-a" />);
		expect(view.container.querySelector("iframe")).toBeNull();
		expect(screen.getByText("Frame not found.")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /^(share|publish)/i }),
		).toBeNull();
	});
});

describe("chat preview runtime authority", () => {
	it("uses the authorized frame's embed and declared tools through the actual host", async () => {
		const view = render(panel());
		const iframe = view.container.querySelector("iframe");
		if (!iframe) {
			throw new Error("Expected the authorized preview iframe");
		}
		expect(iframe.getAttribute("src")).toBe(
			"/app/example-org/frames/frame-1/embed",
		);
		call(iframe, TOOLS[0]);
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
		expect(mocks.callTool).toHaveBeenCalledWith(
			TOOLS[0],
			{ projectId: "project-1" },
			{ organizationId: "org-a", pageFrameId: "frame-1" },
		);
		call(iframe, TOOLS[1], "members");
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("reads data without changing it");
		expect(dialog).toHaveTextContent("before every sensitive read");
		expect(dialog).not.toHaveTextContent("can change data in Fabric");
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));
	});

	it("replaces the iframe and refuses its predecessor's tools after a version change", async () => {
		const view = render(panel());
		const original = view.container.querySelector("iframe");
		if (!original) {
			throw new Error("Expected the original iframe");
		}
		mocks.query.mockReturnValue({
			isSuccess: true,
			data: {
				...saved,
				updatedAt: "2026-10-19T11:00:00Z",
				runtimeTools: [],
			},
		});
		view.rerender(panel());
		const replacement = view.container.querySelector("iframe");
		if (!replacement?.contentWindow) {
			throw new Error("Expected the replacement iframe");
		}
		expect(replacement).not.toBe(original);
		const reply = vi.spyOn(replacement.contentWindow, "postMessage");
		call(replacement, TOOLS[0]);
		await waitFor(() => expect(reply).toHaveBeenCalled());
		expect(reply.mock.calls[0][0]).toMatchObject({ ok: false });
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it.each([
		{ isSuccess: false, isLoading: true, data: saved },
		{ isSuccess: false, isError: true, data: saved },
		{ isSuccess: true, data: { ...saved, id: "different-frame" } },
		{ isSuccess: true, data: { ...saved, organizationId: "other-org" } },
	])(
		"mounts no runtime shell without a matching successful read: %j",
		(result) => {
			mocks.query.mockReturnValue(result);
			const view = render(panel());
			expect(view.container.querySelector("iframe")).toBeNull();
			expect(mocks.listTools).not.toHaveBeenCalled();
		},
	);

	it("removes the preview's authority when the viewing organization changes", () => {
		const view = render(panel());
		expect(view.container.querySelector("iframe")).not.toBeNull();
		mocks.viewing.id = "other-org";
		view.rerender(panel());
		expect(view.container.querySelector("iframe")).toBeNull();
	});

	it("keeps an unattended page visible but disables actual runtime calls", async () => {
		mocks.query.mockReturnValue({
			isSuccess: true,
			data: { ...saved, sourceRunType: "workflow" },
		});
		const view = render(panel());
		const iframe = view.container.querySelector("iframe");
		if (!iframe) {
			throw new Error("Expected the static preview iframe");
		}
		call(iframe, TOOLS[0]);
		await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(mocks.listTools).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});
});
