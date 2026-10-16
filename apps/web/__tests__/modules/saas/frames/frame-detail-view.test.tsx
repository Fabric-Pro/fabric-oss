/**
 * One agent-written page in the viewer, as the Artifacts tab and a Workspace
 * both show it: a placeholder while it loads, a plain message when it is gone,
 * and otherwise the viewer, told the tools the page declared and the
 * organization it belongs to.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
	props: [] as Array<Record<string, unknown>>,
	mounts: { count: 0 },
}));

vi.mock("@saas/frames/components/FrameVizShell", async () => {
	const { useEffect } = await import("react");
	return {
		FrameVizShell: (props: Record<string, unknown>) => {
			shell.props.push(props);
			useEffect(() => {
				shell.mounts.count += 1;
			}, []);
			return <div data-testid="frame-shell">{String(props.title)}</div>;
		},
	};
});

import { FrameDetailView } from "@saas/frames/components/FrameDetailView";
import type { FrameDetail } from "@saas/frames/lib/frame-tool-types";

const DETAIL: FrameDetail = {
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
	shareUrl: "https://example.com/share/frame/token",
	updatedAt: "2026-10-14T09:00:00.000Z",
};

beforeEach(() => {
	shell.props.length = 0;
	shell.mounts.count = 0;
});

function view(
	detail: React.ComponentProps<typeof FrameDetailView>["detail"],
	props: Partial<React.ComponentProps<typeof FrameDetailView>> = {},
) {
	return render(
		<FrameDetailView
			detail={detail}
			surface="workspace"
			organizationId="org-1"
			organizationSlug="example-org"
			{...props}
		/>,
	);
}

describe("FrameDetailView", () => {
	it.each(["artifact", "workspace"] as const)(
		"shows a labelled placeholder while the %s loads",
		(surface) => {
			view({ isLoading: true, isError: false }, { surface });

			expect(
				screen.getByRole("status", { name: `Loading ${surface}` }),
			).toBeInTheDocument();
			expect(screen.queryByTestId("frame-shell")).toBeNull();
		},
	);

	it.each(["artifact", "workspace"] as const)(
		"says the %s is gone when it cannot be read",
		(surface) => {
			view({ isLoading: false, isError: true }, { surface });

			expect(screen.getByRole("alert")).toHaveTextContent(
				`This ${surface} is no longer available.`,
			);
			expect(screen.queryByTestId("frame-shell")).toBeNull();
		},
	);

	it("says it is gone when the read came back with nothing", () => {
		view({ isLoading: false, isError: false });

		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("shows the page in the viewer, inside the organization's routes, with what it declared", () => {
		view({ isLoading: false, isError: false, data: DETAIL });

		expect(screen.getByTestId("frame-shell")).toHaveTextContent(
			"Delivery status",
		);
		expect(shell.props.at(-1)).toMatchObject({
			surface: "workspace",
			frameId: "frame-1",
			title: "Delivery status",
			description: "Open work by status.",
			kind: "frame",
			embedUrl: "/app/example-org/frames/frame-1/embed",
			shareUrl: "https://example.com/share/frame/token",
			isPublic: true,
			isProjectFrame: true,
			organizationId: "org-1",
			runtimeTools: ["fabric_list_workflows"],
			frameDocument: {
				version: 1,
				kind: "frame",
				title: "Delivery status",
				blocks: [{ id: "page", type: "html" }],
			},
		});
	});

	it("treats a page with no project and no share link as neither project nor public", () => {
		const { projectId: _project, shareUrl: _share, ...loose } = DETAIL;

		view({ isLoading: false, isError: false, data: loose });

		expect(shell.props.at(-1)).toMatchObject({
			isProjectFrame: false,
			isPublic: false,
		});
	});

	it.each([
		["a workflow wrote", "workflow", false],
		["Fabric Agent wrote in a chat", "direct-chat", true],
		["came in through the gateway", "MCP_GATEWAY", true],
	])(
		"tells the viewer the page is interactive only if it runs its scripts: a page %s",
		(_label, sourceRunType, interactive) => {
			view({
				isLoading: false,
				isError: false,
				data: { ...DETAIL, sourceRunType },
			});

			expect(shell.props.at(-1)).toMatchObject({ interactive });
		},
	);

	it("takes a page with no recorded source for one that runs its scripts", () => {
		view({ isLoading: false, isError: false, data: DETAIL });

		expect(shell.props.at(-1)).toMatchObject({ interactive: true });
	});

	it("passes on what the surface decided about sharing and about Fabric Agent", () => {
		const onOpenAgent = vi.fn();
		const onSharingChanged = vi.fn();

		view(
			{ isLoading: false, isError: false, data: DETAIL },
			{ onOpenAgent, onSharingChanged, canManageSharing: true },
		);

		expect(shell.props.at(-1)).toMatchObject({
			onOpenAgent,
			onSharingChanged,
			canManageSharing: true,
		});
	});

	it("offers no sharing control unless the surface says the viewer wrote the page", () => {
		view({ isLoading: false, isError: false, data: DETAIL });

		expect(shell.props.at(-1)).toMatchObject({ canManageSharing: false });
	});

	it("reloads the viewer when the page's content changes, and not when it is read again unchanged", () => {
		const detail = (data: FrameDetail) => ({
			isLoading: false,
			isError: false,
			data,
		});
		const rendered = view(detail(DETAIL));
		expect(shell.mounts.count).toBe(1);

		rendered.rerender(
			<FrameDetailView
				detail={detail({ ...DETAIL })}
				surface="workspace"
				organizationId="org-1"
				organizationSlug="example-org"
			/>,
		);
		expect(shell.mounts.count).toBe(1);

		rendered.rerender(
			<FrameDetailView
				detail={detail({
					...DETAIL,
					updatedAt: "2026-10-14T10:00:00.000Z",
				})}
				surface="workspace"
				organizationId="org-1"
				organizationSlug="example-org"
			/>,
		);
		expect(shell.mounts.count).toBe(2);
		expect(screen.getAllByTestId("frame-shell")).toHaveLength(1);
	});
});
