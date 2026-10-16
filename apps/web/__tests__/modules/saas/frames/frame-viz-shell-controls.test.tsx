/**
 * What the frame shell draws around a page: what the page is called, and the
 * one Share control. A page the viewer wrote opens the sharing sheet; a public
 * link is offered to anyone else who can see one; Publish where there is
 * neither. Never two of them.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sheet = vi.hoisted(() => ({
	props: [] as Array<{
		frameId: string;
		open: boolean;
		onOpenChange: (open: boolean) => void;
	}>,
}));

vi.mock("../../../../modules/saas/frames/components/ShareFrameSheet", () => ({
	ShareFrameSheet: (props: (typeof sheet.props)[number]) => {
		sheet.props.push(props);
		return props.open ? (
			<div data-testid="share-sheet">
				<button type="button" onClick={() => props.onOpenChange(false)}>
					close share
				</button>
			</div>
		) : null;
	},
}));

vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-a",
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

import { FrameVizShell } from "@saas/frames/components/FrameVizShell";

const DOCUMENT = {
	version: 1 as const,
	kind: "frame" as const,
	title: "Delivery",
	blocks: [{ id: "page", type: "html" as const, content: "<p>page</p>" }],
};

function renderShell(
	props: Partial<React.ComponentProps<typeof FrameVizShell>> = {},
) {
	return render(
		<FrameVizShell
			title="Delivery"
			kind="frame"
			embedUrl="/app/example-org/frames/f1/embed"
			organizationId="org-a"
			frameDocument={DOCUMENT}
			{...props}
		/>,
	);
}

beforeEach(() => {
	sheet.props.length = 0;
});

describe("what a page is called", () => {
	it("names a page by its surface, without the plain kind badge", () => {
		renderShell({ surface: "workspace" });

		expect(screen.getByText("Workspace")).toBeInTheDocument();
		expect(screen.queryByText("Frame")).toBeNull();
	});

	it("names an artifact an artifact", () => {
		renderShell({ surface: "artifact" });

		expect(screen.getByText("Artifact")).toBeInTheDocument();
	});

	it("names a page that is on no surface by what it is, with its kind", () => {
		renderShell();

		expect(screen.getByText("Interactive content")).toBeInTheDocument();
		expect(screen.getByText("Frame")).toBeInTheDocument();
	});

	it("names a shared page by being shared", () => {
		renderShell({ headerMode: "public" });

		expect(screen.getByText("Shared Frame")).toBeInTheDocument();
	});

	it("says what it is loading in the surface's words", () => {
		renderShell({ surface: "workspace" });

		expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
	});
});

describe("whether the page is interactive", () => {
	it("calls a page that runs its scripts Interactive", () => {
		renderShell({ surface: "workspace" });

		expect(screen.getByText("Interactive")).toBeInTheDocument();
		expect(screen.queryByText("Static")).toBeNull();
	});

	it("calls a page drawn without its scripts Static, and never Interactive", () => {
		renderShell({ surface: "artifact", interactive: false });

		expect(screen.getByText("Static")).toBeInTheDocument();
		expect(screen.queryByText("Interactive")).toBeNull();
	});

	it("keeps the other chips of a static page", () => {
		renderShell({
			surface: "artifact",
			interactive: false,
			isProjectFrame: true,
		});

		expect(screen.getByText("Project")).toBeInTheDocument();
		expect(screen.getByText("Static")).toBeInTheDocument();
	});

	it("is true unless it is told otherwise", () => {
		renderShell();

		expect(screen.getByText("Interactive")).toBeInTheDocument();
	});

	it("puts no chip in a chat's panel, whichever kind of page it shows", () => {
		const first = renderShell({ presentation: "panel" });
		expect(screen.queryByText("Interactive")).toBeNull();
		expect(screen.queryByText("Static")).toBeNull();
		first.unmount();

		renderShell({ presentation: "panel", interactive: false });
		expect(screen.queryByText("Static")).toBeNull();
	});
});

describe("the one Share control", () => {
	it("is the sharing sheet for the page's author, and only that", () => {
		renderShell({
			surface: "workspace",
			frameId: "frame-1",
			canManageSharing: true,
			shareUrl: "https://example.com/share/frame/token",
			onPublish: vi.fn(),
		});

		expect(
			screen.getAllByRole("button", { name: /share|publish/i }),
		).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
		expect(screen.queryByTestId("share-sheet")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Share" }));

		expect(screen.getByTestId("share-sheet")).toBeInTheDocument();
		expect(sheet.props.at(-1)).toMatchObject({
			frameId: "frame-1",
			open: true,
		});
	});

	it("tells the surface when the sheet is closed, so it can read what changed", () => {
		const onSharingChanged = vi.fn();
		renderShell({
			frameId: "frame-1",
			canManageSharing: true,
			onSharingChanged,
		});
		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(onSharingChanged).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "close share" }));

		expect(onSharingChanged).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("share-sheet")).toBeNull();
	});

	it("is the public link for a reader who is not the author", () => {
		renderShell({
			frameId: "frame-1",
			canManageSharing: false,
			shareUrl: "https://example.com/share/frame/token",
		});

		expect(screen.getAllByRole("button", { name: "Share" })).toHaveLength(
			1,
		);
		expect(sheet.props).toEqual([]);
	});

	it("is Publish where there is no sheet and no link", () => {
		const onPublish = vi.fn();
		renderShell({ onPublish });

		fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		expect(onPublish).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
	});

	it("is absent where nothing can be shared", () => {
		renderShell({ frameId: "frame-1", canManageSharing: false });

		expect(
			screen.queryByRole("button", { name: /^(share|publish)/i }),
		).toBeNull();
	});

	it("does not offer the sheet to an author when there is no frame to share", () => {
		renderShell({ canManageSharing: true });

		expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
		expect(sheet.props).toEqual([]);
	});

	it("is a compact icon button, named, in a chat's panel", () => {
		renderShell({
			presentation: "panel",
			frameId: "frame-1",
			canManageSharing: true,
		});

		expect(
			screen.getByRole("button", { name: "Share frame" }),
		).toBeInTheDocument();
	});
});

describe("the other controls", () => {
	it("switches between the page and its code", () => {
		renderShell();

		fireEvent.click(screen.getByRole("button", { name: "Code" }));

		expect(
			screen.getByRole("button", { name: "Render" }),
		).toBeInTheDocument();
		expect(screen.getByText(/"blocks"/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Render" }));
		expect(screen.queryByText(/"blocks"/)).toBeNull();
	});

	it("opens and leaves fullscreen", () => {
		renderShell();

		fireEvent.click(screen.getByRole("button", { name: /fullscreen/i }));
		fireEvent.click(
			screen.getByRole("button", { name: "Exit fullscreen" }),
		);

		expect(
			screen.queryByRole("button", { name: "Exit fullscreen" }),
		).toBeNull();
	});

	it("leaves fullscreen on Escape", () => {
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: /fullscreen/i }));

		fireEvent.keyDown(document, { key: "Escape" });

		expect(
			screen.queryByRole("button", { name: "Exit fullscreen" }),
		).toBeNull();
	});

	it("offers Export in a panel only when the frame's JSON is known", () => {
		const { unmount } = renderShell({ presentation: "panel" });
		expect(
			screen.getByRole("button", { name: "Export" }),
		).toBeInTheDocument();
		unmount();

		renderShell({ presentation: "panel", frameDocument: undefined });
		expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
	});

	it("leaves the header out when asked to", () => {
		renderShell({ hideHeader: true });

		expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
		expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
	});
});
