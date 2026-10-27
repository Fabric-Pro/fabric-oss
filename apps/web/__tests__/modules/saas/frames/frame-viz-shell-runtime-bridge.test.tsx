/**
 * The host page's side of the page runtime. A sandboxed page's script asks, by
 * message, to run a Fabric tool as the person looking at it. These cases pin
 * every check between the message and the tool: who sent it, whether the page
 * declared the tool, whether it only reads, whether the viewer said yes, how
 * often, and where the page may send the viewer.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	callFabricTool: vi.fn(),
	listFabricTools: vi.fn(),
	push: vi.fn(),
	saveBase64File: vi.fn(),
	viewing: { organizationId: "org-a" as string | null },
}));

vi.mock("@saas/frames/lib/download-file", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/frames/lib/download-file")
	>()),
	saveBase64File: mocks.saveBase64File,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => mocks.viewing.organizationId,
}));

vi.mock("../../../../modules/saas/frames/components/ShareFrameSheet", () => ({
	ShareFrameSheet: () => null,
}));

vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/fabric-tool-client")
	>()),
	callFabricTool: mocks.callFabricTool,
	listFabricTools: mocks.listFabricTools,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));

import { FrameVizShell } from "@saas/frames/components/FrameVizShell";
import { FRAME_RUNTIME_RATE_LIMIT } from "@saas/frames/lib/frame-runtime-host";

const EMBED_URL = "/app/example-org/frames/f1/embed";

/** How a call made for a page reaches the gateway: in its organization, for its frame. */
const AS_THE_PAGE = {
	organizationId: "org-a",
	pageFrameId: expect.stringMatching(/^frame-\d+$/),
};
const DECLARED = ["fabric_list_workflows", "fabric_execute_workflow"];

/** A file a page offers the viewer. */
const OFFER = {
	type: "fabric-frame:download",
	filename: "report.csv",
	mimeType: "text/csv",
	dataBase64: btoa("a,b\n1,2\n"),
};

function pageDocument(html = "<p>page</p>") {
	return {
		version: 1 as const,
		kind: "frame" as const,
		title: "Delivery",
		blocks: [{ id: "page", type: "html" as const, content: html }],
	};
}

let frameCounter = 0;

function renderShell(
	props: Partial<React.ComponentProps<typeof FrameVizShell>> = {},
) {
	frameCounter += 1;
	const view = render(
		<FrameVizShell
			frameId={`frame-${frameCounter}`}
			title="Delivery"
			kind="frame"
			embedUrl={EMBED_URL}
			runtimeTools={DECLARED}
			organizationId="org-a"
			frameDocument={pageDocument()}
			{...props}
		/>,
	);
	const iframe = view.container.querySelector("iframe") as HTMLIFrameElement;
	const embed = iframe.contentWindow as Window;
	const replies: Array<Record<string, unknown>> = [];
	const targets: unknown[] = [];
	vi.spyOn(embed, "postMessage").mockImplementation(
		(message: unknown, targetOrigin?: unknown) => {
			replies.push(message as Record<string, unknown>);
			targets.push(targetOrigin);
		},
	);
	return { ...view, iframe, embed, replies, targets };
}

function send(
	source: Window,
	data: unknown,
	origin: string = window.location.origin,
) {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

const call = (name: string, requestId = "r1", args = {}) => ({
	type: "fabric-frame:call",
	requestId,
	name,
	args,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.viewing.organizationId = "org-a";
	mocks.listFabricTools.mockResolvedValue([
		{ name: "fabric_list_workflows", annotations: { readOnlyHint: true } },
		{ name: "fabric_execute_workflow" },
	]);
	mocks.callFabricTool.mockResolvedValue({ ok: true });
	try {
		window.sessionStorage.clear();
	} catch {
		// Storage unavailable: approvals then live in memory only.
	}
});

describe("who may speak for the page", () => {
	it("ignores a request from a window that is not the embed this shell frames", async () => {
		const { replies } = renderShell();
		const stranger = document.createElement("iframe");
		document.body.appendChild(stranger);

		send(stranger.contentWindow as Window, call("fabric_list_workflows"));
		send(window, call("fabric_list_workflows"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.callFabricTool).not.toHaveBeenCalled();
		expect(replies).toEqual([]);
		stranger.remove();
	});

	it("ignores a request that carries a foreign origin, even from the embed's window", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_list_workflows"), "https://attacker.example");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.callFabricTool).not.toHaveBeenCalled();
		expect(replies).toEqual([]);
	});

	it("ignores a message that is not one of the runtime's", async () => {
		const { embed, replies } = renderShell();

		send(embed, { type: "fabric-frame:call", requestId: "r1", name: 4 });
		send(embed, { type: "fabric-frame:set-height", height: 900 });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.callFabricTool).not.toHaveBeenCalled();
		expect(replies).toEqual([]);
	});
});

describe("running a tool", () => {
	it("runs a declared read-only tool at once and answers the embed, to its origin only", async () => {
		const { embed, replies, targets } = renderShell();

		send(embed, call("fabric_list_workflows", "r1", { limit: 3 }));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(mocks.callFabricTool).toHaveBeenCalledWith(
			"fabric_list_workflows",
			{ limit: 3 },
			AS_THE_PAGE,
		);
		expect(replies[0]).toEqual({
			type: "fabric-frame:call-result",
			requestId: "r1",
			ok: true,
			result: { ok: true },
		});
		expect(targets[0]).toBe(window.location.origin);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("refuses a tool the page did not declare", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_get_frame"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false, requestId: "r1" });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("refuses every tool when the page declared none", async () => {
		const { embed, replies } = renderShell({ runtimeTools: undefined });

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("answers with the reason when the tool fails", async () => {
		mocks.callFabricTool.mockRejectedValue(new Error("Workflow not found"));
		const { embed, replies } = renderShell();

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({
			ok: false,
			error: "Workflow not found",
		});
	});

	it("answers when the tool list cannot be read", async () => {
		mocks.listFabricTools.mockRejectedValue(new Error("offline"));
		const { embed, replies } = renderShell();

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false, error: "offline" });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("accepts a request from the fullscreen view of the same page", async () => {
		const { embed, replies } = renderShell();
		fireEvent.click(screen.getByRole("button", { name: /fullscreen/i }));
		const fullscreen = Array.from(document.querySelectorAll("iframe")).find(
			(candidate) => candidate.contentWindow !== embed,
		);
		const fullscreenWindow = fullscreen?.contentWindow as Window;
		const fullscreenReplies: unknown[] = [];
		vi.spyOn(fullscreenWindow, "postMessage").mockImplementation(
			(message: unknown) => {
				fullscreenReplies.push(message);
			},
		);

		send(fullscreenWindow, call("fabric_list_workflows", "fs-1"));

		await waitFor(() => expect(fullscreenReplies).toHaveLength(1));
		expect(fullscreenReplies[0]).toMatchObject({
			requestId: "fs-1",
			ok: true,
		});
		expect(replies).toEqual([]);
	});
});

describe("a tool that can change something", () => {
	it("asks the viewer first and runs it on a yes", async () => {
		const { embed, replies } = renderShell();

		send(
			embed,
			call("fabric_execute_workflow", "r1", { workflowId: "w1" }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Allow this page to run workflow?");
		expect(dialog).toHaveTextContent("fabric_execute_workflow");
		expect(dialog).toHaveTextContent(/workflowId\s*w1/);
		expect(mocks.callFabricTool).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(mocks.callFabricTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{ workflowId: "w1" },
			AS_THE_PAGE,
		);
		expect(replies[0]).toMatchObject({ ok: true, requestId: "r1" });
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).toBeNull(),
		);
	});

	it("does not run it, and says so, when the viewer declines", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_execute_workflow"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("asks once per page and tool, not on every call", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));

		send(embed, call("fabric_execute_workflow", "r2"));

		await waitFor(() => expect(replies).toHaveLength(2));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.callFabricTool).toHaveBeenCalledTimes(2);
	});

	it("asks on every call to a tool whose listing says it always asks, and says so", async () => {
		mocks.listFabricTools.mockResolvedValue([
			{
				name: "fabric_execute_workflow",
				_meta: { "fabric/confirm": true },
			},
		]);
		const { embed, replies } = renderShell();

		send(embed, call("fabric_execute_workflow", "r1"));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("always needs your yes");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));

		send(embed, call("fabric_execute_workflow", "r2"));
		await screen.findByRole("alertdialog");
		expect(replies).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(replies).toHaveLength(2));
		expect(mocks.callFabricTool).toHaveBeenCalledTimes(2);
	});

	it("remembers a yes for the page when it is opened again in the same browser session", async () => {
		const first = renderShell({ frameId: "frame-remembered" });
		send(first.embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const second = renderShell({ frameId: "frame-remembered" });
		// A page's script calls after its document has loaded; by then the
		// shell has worked out which version of the page it is.
		await new Promise((resolve) => setTimeout(resolve, 20));
		send(second.embed, call("fabric_execute_workflow", "r2"));

		await waitFor(() => expect(second.replies).toHaveLength(1));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(second.replies[0]).toMatchObject({ ok: true });
	});

	it("asks again for another page, and for another tool", async () => {
		const first = renderShell({ frameId: "frame-a" });
		send(first.embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const second = renderShell({ frameId: "frame-b" });
		send(second.embed, call("fabric_execute_workflow", "r2"));

		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(second.replies).toHaveLength(1));
	});

	it("asks again once the page has been edited, for a tool it was allowed before", async () => {
		const first = renderShell({
			frameId: "frame-edited",
			frameDocument: pageDocument("<p>refresh</p>"),
		});
		send(first.embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const edited = renderShell({
			frameId: "frame-edited",
			frameDocument: pageDocument(
				"<p>refresh</p><script>/* the author changed it */</script>",
			),
		});
		send(edited.embed, call("fabric_execute_workflow", "r2"));

		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		expect(mocks.callFabricTool).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(edited.replies).toHaveLength(1));
	});

	it("asks again when the page declares other tools than it did when it was allowed", async () => {
		const first = renderShell({ frameId: "frame-tools" });
		send(first.embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const widened = renderShell({
			frameId: "frame-tools",
			runtimeTools: [...DECLARED, "fabric_pause_workflow"],
		});
		send(widened.embed, call("fabric_execute_workflow", "r2"));

		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(widened.replies).toHaveLength(1));
	});

	it("remembers nothing for a page it has no content to tell versions apart by", async () => {
		const { embed, replies } = renderShell({ frameDocument: undefined });

		send(embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));
		send(embed, call("fabric_execute_workflow", "r2"));

		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(replies).toHaveLength(2));
	});

	it("shows the values nested in the call it asks about, under their path", async () => {
		const { embed } = renderShell();

		send(
			embed,
			call("fabric_execute_workflow", "r1", {
				workflowId: "w1",
				inputs: { region: "eu", targets: ["a", "b"] },
			}),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/inputs\.region\s*eu/);
		expect(dialog).toHaveTextContent(/inputs\.targets\s*a, b/);
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
	});

	it("asks one question at a time when several tools wait", async () => {
		const { embed, replies } = renderShell({
			runtimeTools: ["fabric_execute_workflow", "fabric_pause_workflow"],
		});

		send(embed, call("fabric_execute_workflow", "r1"));
		send(embed, call("fabric_pause_workflow", "r2"));

		const first = await screen.findByRole("alertdialog");
		expect(first).toHaveTextContent("fabric_execute_workflow");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() =>
			expect(screen.getByRole("alertdialog")).toHaveTextContent(
				"fabric_pause_workflow",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(2));
	});

	it("leaves fullscreen so the question is not hidden behind it", async () => {
		const { embed } = renderShell();
		fireEvent.click(screen.getByRole("button", { name: /fullscreen/i }));
		expect(
			screen.getByRole("button", { name: "Exit fullscreen" }),
		).toBeInTheDocument();

		send(embed, call("fabric_execute_workflow"));

		await screen.findByRole("alertdialog");
		expect(
			screen.queryByRole("button", { name: "Exit fullscreen" }),
		).toBeNull();
	});
});

describe("a tool no page may call", () => {
	it.each([
		"fabric_create_workflow",
		"fabric_publish_workflow",
		"fabric_update_frame",
		"fabric_edit_frame_block",
		"fabric_request_authority",
	])("refuses %s even though the stored page declares it", async (name) => {
		const { embed, replies } = renderShell({ runtimeTools: [name] });

		send(embed, call(name, "r1", { anything: 1 }));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false, requestId: "r1" });
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});
});

describe("the organization of a call", () => {
	it("refuses a page of another organization than the one in the viewer's address", async () => {
		mocks.viewing.organizationId = "org-b";
		const { embed, replies } = renderShell({ organizationId: "org-a" });

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(replies[0].ok === false ? replies[0].error : "").toContain(
			"does not belong to the organization you are viewing",
		);
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
		expect(mocks.listFabricTools).not.toHaveBeenCalled();
	});

	it("refuses a page whose organization the shell was not told", async () => {
		const { embed, replies } = renderShell({ organizationId: null });

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("refuses while the organization in the address is not known yet", async () => {
		mocks.viewing.organizationId = null;
		const { embed, replies } = renderShell();

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("names the organization in the tool list read and in the call", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_execute_workflow", "r1"));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));

		expect(mocks.listFabricTools).toHaveBeenCalledWith({
			organizationId: "org-a",
		});
		expect(mocks.callFabricTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{},
			AS_THE_PAGE,
		);
	});
});

describe("how often", () => {
	it("refuses calls past the limit within a minute", async () => {
		const { embed, replies } = renderShell();
		const total = FRAME_RUNTIME_RATE_LIMIT.maxCalls + 1;

		for (let index = 0; index < total; index++) {
			send(embed, call("fabric_list_workflows", `r${index}`));
		}

		await waitFor(() => expect(replies).toHaveLength(total));
		const refused = replies.filter((reply) => reply.ok === false);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({ requestId: `r${total - 1}` });
		expect(mocks.callFabricTool).toHaveBeenCalledTimes(
			FRAME_RUNTIME_RATE_LIMIT.maxCalls,
		);
	});
});

describe("navigate and openAgent", () => {
	it("takes the viewer to a page of the app", async () => {
		const { embed } = renderShell();

		send(embed, {
			type: "fabric-frame:navigate",
			path: "/app/example-org/projects?tab=artifacts",
		});

		await waitFor(() =>
			expect(mocks.push).toHaveBeenCalledWith(
				"/app/example-org/projects?tab=artifacts",
			),
		);
	});

	it.each([
		"https://evil.example/app/x",
		"//evil.example/app/x",
		"/api/auth/sign-out",
		"/app/../api/session",
	])("will not take the viewer to %s", async (path) => {
		const { embed } = renderShell();

		send(embed, { type: "fabric-frame:navigate", path });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.push).not.toHaveBeenCalled();
	});

	it("opens Fabric Agent with the page's prompt as a draft", async () => {
		const onOpenAgent = vi.fn();
		const { embed } = renderShell({ onOpenAgent });

		send(embed, {
			type: "fabric-frame:open-agent",
			prompt: "Explain this",
		});

		await waitFor(() =>
			expect(onOpenAgent).toHaveBeenCalledWith("Explain this"),
		);
	});

	it("does nothing where there is no agent to open", async () => {
		const { embed, replies } = renderShell();

		send(embed, {
			type: "fabric-frame:open-agent",
			prompt: "Explain this",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(replies).toEqual([]);
	});

	it("takes neither from a shell that has no signed-in viewer", async () => {
		const onOpenAgent = vi.fn();
		const { embed } = renderShell({ headerMode: "public", onOpenAgent });

		send(embed, {
			type: "fabric-frame:navigate",
			path: "/app/example-org",
		});
		send(embed, {
			type: "fabric-frame:open-agent",
			prompt: "Explain this",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(mocks.push).not.toHaveBeenCalled();
		expect(onOpenAgent).not.toHaveBeenCalled();
	});
});

describe("a shell with no signed-in viewer (a public share)", () => {
	it("refuses every tool even though the page declared it", async () => {
		const { embed, replies } = renderShell({ headerMode: "public" });

		send(embed, call("fabric_list_workflows"));

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("saves no file the page offers, and asks nothing", async () => {
		const { embed } = renderShell({ headerMode: "public" });

		send(embed, OFFER);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.saveBase64File).not.toHaveBeenCalled();
	});
});

describe("a page that keeps data", () => {
	const KEEPING = [
		"fabric_page_data_list",
		"fabric_page_data_set",
		"fabric_get_page_viewer",
		"fabric_execute_workflow",
	];
	const VOTE = {
		collection: "votes",
		records: [{ key: "@me", value: { pick: "a" } }],
	};

	beforeEach(() => {
		mocks.listFabricTools.mockResolvedValue([
			{
				name: "fabric_page_data_list",
				annotations: { readOnlyHint: true },
			},
			{ name: "fabric_page_data_set" },
			{
				name: "fabric_get_page_viewer",
				annotations: { readOnlyHint: true },
			},
			{ name: "fabric_execute_workflow" },
		]);
	});

	it("runs a call for the page's own frame, and names that frame to the gateway", async () => {
		const { embed, replies } = renderShell({
			frameId: "frame-own",
			runtimeTools: KEEPING,
		});

		send(
			embed,
			call("fabric_page_data_list", "r1", {
				frameId: "somebody-elses-page",
				collection: "votes",
			}),
		);

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(mocks.callFabricTool).toHaveBeenCalledWith(
			"fabric_page_data_list",
			{ frameId: "frame-own", collection: "votes" },
			{ organizationId: "org-a", pageFrameId: "frame-own" },
		);
	});

	it("refuses a call while the page has not been saved", async () => {
		const { embed, replies } = renderShell({
			frameId: undefined,
			runtimeTools: KEEPING,
		});

		send(
			embed,
			call("fabric_page_data_list", "r1", { collection: "votes" }),
		);

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({ ok: false });
		expect(mocks.callFabricTool).not.toHaveBeenCalled();
	});

	it("asks before every other change, not once, and says why", async () => {
		const { embed, replies } = renderShell({ runtimeTools: KEEPING });

		for (const id of ["r1", "r2"]) {
			send(embed, call("fabric_execute_workflow", id));
			const dialog = await screen.findByRole("alertdialog");
			expect(dialog).toHaveTextContent(/keeps shared data/);
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() =>
				expect(
					replies.filter((reply) => reply.requestId === id),
				).toHaveLength(1),
			);
		}

		expect(mocks.callFabricTool).toHaveBeenCalledTimes(2);
	});

	it("asks once about a write to its own data", async () => {
		const { embed, replies } = renderShell({ runtimeTools: KEEPING });

		send(embed, call("fabric_page_data_set", "r1", VOTE));
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));
		send(embed, call("fabric_page_data_set", "r2", VOTE));

		await waitFor(() => expect(replies).toHaveLength(2));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("asks before each write to shared data once the page has read who the viewer is", async () => {
		const { embed, replies } = renderShell({ runtimeTools: KEEPING });

		send(embed, call("fabric_get_page_viewer", "r1"));
		await waitFor(() => expect(replies).toHaveLength(1));
		for (const id of ["r2", "r3"]) {
			send(embed, call("fabric_page_data_set", id, VOTE));
			const dialog = await screen.findByRole("alertdialog");
			expect(dialog).toHaveTextContent(/read information from outside/);
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() =>
				expect(
					replies.filter((reply) => reply.requestId === id),
				).toHaveLength(1),
			);
		}

		expect(mocks.callFabricTool).toHaveBeenCalledTimes(3);
	});

	it("retains what the page has read when it is edited inside the same shell", async () => {
		const first = renderShell({
			frameId: "frame-edited-data",
			runtimeTools: KEEPING,
			frameDocument: pageDocument("<p>vote</p>"),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		send(first.embed, call("fabric_get_page_viewer", "r1"));
		await waitFor(() => expect(first.replies).toHaveLength(1));

		first.rerender(
			<FrameVizShell
				frameId="frame-edited-data"
				title="Delivery"
				kind="frame"
				embedUrl={EMBED_URL}
				runtimeTools={KEEPING}
				organizationId="org-a"
				frameDocument={pageDocument("<p>vote, edited</p>")}
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const iframe = first.container.querySelector(
			"iframe",
		) as HTMLIFrameElement;
		const embed = iframe.contentWindow as Window;
		const replies: Array<Record<string, unknown>> = [];
		vi.spyOn(embed, "postMessage").mockImplementation(
			(message: unknown) => {
				replies.push(message as Record<string, unknown>);
			},
		);
		for (const id of ["r2", "r3"]) {
			send(embed, call("fabric_page_data_set", id, VOTE));
			const dialog = await screen.findByRole("alertdialog");
			expect(dialog).toHaveTextContent(/read information from outside/);
			expect(dialog).toHaveTextContent(/records\[0\]\.value\.pick\s*a/);
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() =>
				expect(
					replies.filter((reply) => reply.requestId === id),
				).toHaveLength(1),
			);
		}

		expect(screen.queryByRole("alertdialog")).toBeNull();
	});
});

describe("a page that has read outside its own data", () => {
	const READ_LINEAR = {
		provider: "linear",
		tool: "list_issues",
		args: {},
	};

	beforeEach(() => {
		mocks.listFabricTools.mockResolvedValue([
			{
				name: "fabric_list_workflows",
				annotations: { readOnlyHint: true },
			},
			{ name: "fabric_execute_workflow" },
			{ name: "fabric_page_read_connected" },
		]);
	});

	async function allow() {
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	}

	it("asks again before a change it was allowed to make, once a connected account has been read", async () => {
		const { embed, replies } = renderShell({
			runtimeTools: [
				"fabric_execute_workflow",
				"connected:linear/list_issues",
			],
		});
		const start = { workflowId: "w1" };

		send(embed, call("fabric_execute_workflow", "r1", start));
		await allow();
		await waitFor(() => expect(replies).toHaveLength(1));
		send(embed, call("fabric_execute_workflow", "r2", start));
		await waitFor(() => expect(replies).toHaveLength(2));
		expect(screen.queryByRole("alertdialog")).toBeNull();

		send(embed, call("fabric_page_read_connected", "r3", READ_LINEAR));
		await allow();
		await waitFor(() => expect(replies).toHaveLength(3));
		send(embed, call("fabric_execute_workflow", "r4", start));

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/read information from outside/);
		expect(dialog).toHaveTextContent(/workflowId\s*w1/);
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(replies).toHaveLength(4));
		expect(replies[3]).toMatchObject({ requestId: "r4", ok: false });
		expect(
			mocks.callFabricTool.mock.calls.filter(
				([name]) => name === "fabric_execute_workflow",
			),
		).toHaveLength(2);
	});

	it("still asks before each further read after a reload, since a reload does not forget what the page read", async () => {
		const runtimeTools = [
			"connected:linear/list_issues",
			"connected:linear/get_issue",
		];
		const first = renderShell({ frameId: "frame-linear", runtimeTools });
		send(
			first.embed,
			call("fabric_page_read_connected", "r1", READ_LINEAR),
		);
		await allow();
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const second = renderShell({ frameId: "frame-linear", runtimeTools });
		await new Promise((resolve) => setTimeout(resolve, 20));
		send(
			second.embed,
			call("fabric_page_read_connected", "r2", READ_LINEAR),
		);

		expect(await screen.findByRole("alertdialog")).toHaveTextContent(
			"has read information from outside itself",
		);
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
		await waitFor(() => expect(second.replies).toHaveLength(1));
		expect(second.replies[0]).toMatchObject({ requestId: "r2", ok: false });
	});

	it("does not carry one page's read over to another page", async () => {
		const runtimeTools = ["connected:linear/list_issues"];
		const first = renderShell({ frameId: "frame-linear", runtimeTools });
		send(
			first.embed,
			call("fabric_page_read_connected", "r1", READ_LINEAR),
		);
		await allow();
		await waitFor(() => expect(first.replies).toHaveLength(1));
		first.unmount();

		const other = renderShell({ frameId: "frame-other", runtimeTools });
		send(
			other.embed,
			call("fabric_page_read_connected", "r2", READ_LINEAR),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).not.toHaveTextContent(
			"has read information from outside itself",
		);
		fireEvent.click(screen.getByRole("button", { name: /don.t allow/i }));
	});
});

describe("a page that asks faster than the viewer can answer", () => {
	const TOOLS = [
		"fabric_execute_workflow",
		"fabric_pause_workflow",
		"fabric_resume_workflow",
		"fabric_delete_story",
		"fabric_update_story",
		"fabric_create_story",
	];

	it("has five questions waiting and no more, refusing the sixth as busy", async () => {
		const { embed, replies } = renderShell({ runtimeTools: TOOLS });

		TOOLS.forEach((tool, index) => {
			send(embed, call(tool, `r${index + 1}`));
		});

		await waitFor(() => expect(replies).toHaveLength(1));
		expect(replies[0]).toMatchObject({
			requestId: "r6",
			ok: false,
			reason: "busy",
			retryable: true,
		});
		for (const [index, tool] of TOOLS.slice(0, 5).entries()) {
			const dialog = await screen.findByRole("alertdialog");
			expect(dialog).toHaveTextContent(tool);
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() =>
				expect(
					replies.filter((reply) => reply.ok === true),
				).toHaveLength(index + 1),
			);
		}
		expect(mocks.callFabricTool.mock.calls.map(([name]) => name)).toEqual(
			TOOLS.slice(0, 5),
		);
	});

	it("takes a question again once one has been answered", async () => {
		const { embed, replies } = renderShell({ runtimeTools: TOOLS });
		TOOLS.slice(0, 5).forEach((tool, index) => {
			send(embed, call(tool, `r${index + 1}`));
		});
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));

		send(embed, call(TOOLS[5], "r6"));
		for (let answered = 1; answered < 6; answered++) {
			await screen.findByRole("alertdialog");
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() => expect(replies).toHaveLength(answered + 1));
		}

		expect(replies.every((reply) => reply.ok === true)).toBe(true);
		expect(replies.map((reply) => reply.requestId)).toContain("r6");
	});

	it("declines a file offered beyond the limit, without asking and without telling the page", async () => {
		const { embed, replies } = renderShell({ runtimeTools: TOOLS });
		TOOLS.slice(0, 5).forEach((tool, index) => {
			send(embed, call(tool, `r${index + 1}`));
		});
		await screen.findByRole("alertdialog");
		await new Promise((resolve) => setTimeout(resolve, 30));

		send(embed, OFFER);
		for (let answered = 0; answered < 5; answered++) {
			await screen.findByRole("alertdialog");
			fireEvent.click(screen.getByRole("button", { name: "Allow" }));
			await waitFor(() => expect(replies).toHaveLength(answered + 1));
		}
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.saveBase64File).not.toHaveBeenCalled();
		expect(
			replies.every((reply) => reply.type !== "fabric-frame:download"),
		).toBe(true);
	});
});

describe("a file the page offers", () => {
	it("asks the viewer, naming the file and its size, and saves it on a yes", async () => {
		const { embed } = renderShell();

		send(embed, OFFER);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Save report.csv, 8 B?");
		expect(dialog).toHaveTextContent("text/csv");
		expect(mocks.saveBase64File).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mocks.saveBase64File).toHaveBeenCalledWith({
				filename: "report.csv",
				mimeType: "text/csv",
				bytes: 8,
				dataBase64: OFFER.dataBase64,
			}),
		);
	});

	it("saves nothing when the viewer declines", async () => {
		const { embed } = renderShell();

		send(embed, OFFER);
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: /don.t save/i }));
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).toBeNull(),
		);

		expect(mocks.saveBase64File).not.toHaveBeenCalled();
	});

	it("asks again for the next file, whatever was said to the last", async () => {
		const { embed } = renderShell();

		send(embed, OFFER);
		await screen.findByRole("alertdialog");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(mocks.saveBase64File).toHaveBeenCalledTimes(1),
		);
		send(embed, { ...OFFER, filename: "second.csv" });

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Save second.csv");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(mocks.saveBase64File).toHaveBeenCalledTimes(2),
		);
	});

	it("is not asked about a kind of file a page may not offer", async () => {
		const { embed } = renderShell();

		send(embed, { ...OFFER, filename: "setup.exe", mimeType: "text/csv" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.saveBase64File).not.toHaveBeenCalled();
	});

	it("is not asked about by a page of another organization than the viewer's", async () => {
		mocks.viewing.organizationId = "org-b";
		const { embed } = renderShell({ organizationId: "org-a" });

		send(embed, OFFER);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(mocks.saveBase64File).not.toHaveBeenCalled();
	});

	it("is not believed from a window that is not the embed", async () => {
		renderShell();

		send(window, OFFER);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("waits its turn behind a question about a tool", async () => {
		const { embed, replies } = renderShell();

		send(embed, call("fabric_execute_workflow", "r1"));
		const tool = await screen.findByRole("alertdialog");
		send(embed, OFFER);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(tool).toHaveTextContent("fabric_execute_workflow");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(replies).toHaveLength(1));

		await waitFor(() =>
			expect(screen.getByRole("alertdialog")).toHaveTextContent(
				"Save report.csv",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(mocks.saveBase64File).toHaveBeenCalledTimes(1),
		);
	});
});
