/**
 * The embed's part of the page runtime: it sits between the sandboxed page and
 * the host page and only relays. A page's request goes up under an id of the
 * embed's own; the host's answer, believed only from the app's own parent
 * window, goes back down under the page's id. Nothing a page posts to the embed
 * from anywhere but its own iframe is believed, and nothing is forwarded to a
 * parent that may be a foreign framing site except by exact origin.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("html2canvas", () => ({
	default: vi.fn(async () => ({
		toDataURL: () => "data:image/png;base64,AAAA",
	})),
}));

vi.mock("../../../../modules/marketing/blog/components/Mermaid", () => ({
	Mermaid: () => null,
}));

vi.mock("../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import {
	FABRIC_RUNTIME_CALL_TIMEOUT_MS,
	FABRIC_RUNTIME_SCRIPT,
} from "@saas/frames/lib/fabric-runtime-script";
import {
	FRAME_RUNTIME_HELLO_TYPE,
	FRAME_RUNTIME_HOST_READY_TYPE,
} from "@saas/frames/lib/frame-embed-protocol";

const frame: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Delivery",
	blocks: [
		{
			id: "page",
			type: "html",
			content: "<button id='go'>Refresh</button>",
		},
	],
};

let toHost: Array<{ message: unknown; targetOrigin: unknown }> = [];

beforeEach(() => {
	toHost = [];
	vi.spyOn(window.parent, "postMessage").mockImplementation(
		(message: unknown, targetOrigin?: unknown) => {
			toHost.push({ message, targetOrigin });
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function pageIframe(container: HTMLElement) {
	const iframe = container.querySelector<HTMLIFrameElement>(
		'iframe[data-frame-scope="project"]',
	);
	if (!iframe?.contentWindow) {
		throw new Error("the strict-sandbox iframe is not rendered");
	}
	return iframe as HTMLIFrameElement & { contentWindow: Window };
}

function messageFrom(source: Window, data: unknown, origin = "null") {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

function hostAnswers(data: unknown, origin = window.location.origin) {
	messageFrom(window.parent, data, origin);
}

const pageCall = (requestId = "call-1", name = "fabric_list_workflows") => ({
	type: "fabric-frame:call",
	requestId,
	name,
	args: { limit: 2 },
});

describe("a strict-sandbox page in an embed", () => {
	it("is sandboxed to scripts and forms, never same-origin, and carries the page runtime", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const iframe = pageIframe(container);

		expect(iframe.getAttribute("sandbox")).toBe(
			"allow-scripts allow-forms",
		);
		expect(iframe.getAttribute("srcdoc")).toContain("fabric-frame:call");
	});

	it("never draws a page same-origin, whoever wrote it", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);

		const iframes = container.querySelectorAll("iframe");
		expect(iframes).toHaveLength(1);
		expect(iframes[0]?.getAttribute("data-frame-scope")).toBe("project");
		expect(iframes[0]?.getAttribute("sandbox")).not.toContain(
			"allow-same-origin",
		);
	});
});

describe("relaying a page's request up to the host", () => {
	it("forwards a call under the embed's own id, to this app's origin only", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);

		messageFrom(pageIframe(container).contentWindow, pageCall("call-1"));

		const relayed = toHost.filter(
			(entry) =>
				(entry.message as { type?: string }).type ===
				"fabric-frame:call",
		);
		expect(relayed).toHaveLength(1);
		expect(relayed[0].message).toMatchObject({
			name: "fabric_list_workflows",
			args: { limit: 2 },
			requestId: expect.stringMatching(/^relay-/),
		});
		expect(relayed[0].targetOrigin).toBe(window.location.origin);
	});

	it("forwards the requests to open Fabric Agent and to navigate", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const page = pageIframe(container).contentWindow;

		messageFrom(page, {
			type: "fabric-frame:open-agent",
			prompt: "Explain",
		});
		messageFrom(page, {
			type: "fabric-frame:navigate",
			path: "/app/example-org/projects",
		});

		const types = toHost.map(
			(entry) => (entry.message as { type?: string }).type,
		);
		expect(types).toEqual(
			expect.arrayContaining([
				"fabric-frame:open-agent",
				"fabric-frame:navigate",
			]),
		);
		for (const entry of toHost.filter((e) =>
			String((e.message as { type?: string }).type).match(
				/open-agent|navigate/,
			),
		)) {
			expect(entry.targetOrigin).toBe(window.location.origin);
		}
	});

	it("forwards a file the page offers, unchanged, to this app's origin only", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const offer = {
			type: "fabric-frame:download",
			filename: "report.csv",
			mimeType: "text/csv",
			dataBase64: btoa("a,b\n1,2\n"),
		};

		messageFrom(pageIframe(container).contentWindow, offer);

		const relayed = toHost.filter(
			(entry) =>
				(entry.message as { type?: string }).type ===
				"fabric-frame:download",
		);
		expect(relayed).toEqual([
			{ message: offer, targetOrigin: window.location.origin },
		]);
	});

	it("does not forward an offer that is not a file, or is larger than the host would hold", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const page = pageIframe(container).contentWindow;
		const offer = {
			type: "fabric-frame:download",
			filename: "report.csv",
			mimeType: "text/csv",
			dataBase64: "AAAA",
		};

		messageFrom(page, { ...offer, filename: 7 });
		messageFrom(page, { ...offer, dataBase64: undefined });
		messageFrom(page, { ...offer, dataBase64: "A".repeat(14_000_001) });
		messageFrom(page, { ...offer, filename: "n".repeat(501) });

		expect(
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:download",
			),
		).toEqual([]);
	});

	it("ignores a request that does not come from the page's own iframe", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const stranger = document.createElement("iframe");
		document.body.appendChild(stranger);

		messageFrom(stranger.contentWindow as Window, pageCall());
		messageFrom(window, pageCall("call-2"));

		expect(
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:call",
			),
		).toEqual([]);
		expect(pageIframe(container)).toBeTruthy();
		stranger.remove();
	});

	it("ignores a request that is not one of the runtime's", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const page = pageIframe(container).contentWindow;

		messageFrom(page, {
			type: "fabric-frame:call",
			requestId: "x",
			name: 1,
		});
		messageFrom(page, {
			type: "fabric-frame:call",
			requestId: "x",
			name: "n",
			args: ["not", "an", "object"],
		});
		messageFrom(page, {
			type: "fabric-frame:export-png-result",
			requestId: "x",
		});

		expect(
			toHost.filter((entry) =>
				String((entry.message as { type?: string }).type).startsWith(
					"fabric-frame:call",
				),
			),
		).toEqual([]);
	});

	it("still resizes to the height the page reports", () => {
		const { container } = render(<FrameRenderer frame={frame} embedded />);
		const iframe = pageIframe(container);

		messageFrom(iframe.contentWindow, {
			type: "fabric-project-frame:set-height",
			height: 733,
		});

		expect(iframe.style.height).toBe("733px");
	});
});

describe("relaying the host's answer down to the page", () => {
	function setup() {
		const view = render(<FrameRenderer frame={frame} embedded />);
		const iframe = pageIframe(view.container);
		const toPage = vi
			.spyOn(iframe.contentWindow, "postMessage")
			.mockImplementation(() => {});
		messageFrom(iframe.contentWindow, pageCall("call-7"));
		const relayId = (
			toHost.find(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:call",
			)?.message as { requestId: string }
		).requestId;
		return { iframe, toPage, relayId };
	}

	it("hands the result to the page under the id the page used", () => {
		const { toPage, relayId } = setup();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: true,
			result: { workflows: [] },
		});

		expect(toPage).toHaveBeenCalledWith(
			{
				type: "fabric-frame:call-result",
				requestId: "call-7",
				ok: true,
				result: { workflows: [] },
			},
			"*",
		);
	});

	it("hands a refusal to the page the same way", () => {
		const { toPage, relayId } = setup();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: false,
			error: "The viewer did not allow fabric_execute_workflow.",
		});

		expect(toPage).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "call-7",
				ok: false,
				error: "The viewer did not allow fabric_execute_workflow.",
			}),
			"*",
		);
	});

	it("hands the page the reason a tool gave for refusing, and whether to try again", () => {
		const { toPage, relayId } = setup();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: false,
			error: "The page is busy. Try again in a moment.",
			reason: "busy",
			retryable: true,
		});

		expect(toPage).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "call-7",
				ok: false,
				reason: "busy",
				retryable: true,
			}),
			"*",
		);
	});

	it("does not believe an answer whose reason is not text", () => {
		const { toPage, relayId } = setup();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: false,
			error: "x",
			reason: { not: "text" },
		});

		expect(toPage).not.toHaveBeenCalled();
	});

	it("answers a relayed call once", () => {
		const { toPage, relayId } = setup();
		const answer = {
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: true,
			result: 1,
		};

		hostAnswers(answer);
		hostAnswers(answer);

		expect(toPage).toHaveBeenCalledTimes(1);
	});

	it("does not believe an answer from a foreign origin", () => {
		const { toPage, relayId } = setup();

		hostAnswers(
			{
				type: "fabric-frame:call-result",
				requestId: relayId,
				ok: true,
				result: "forged",
			},
			"https://attacker.example",
		);

		expect(toPage).not.toHaveBeenCalled();
	});

	it("does not believe an answer from a window that is not the parent", () => {
		const { iframe, toPage, relayId } = setup();
		const stranger = document.createElement("iframe");
		document.body.appendChild(stranger);

		messageFrom(
			stranger.contentWindow as Window,
			{
				type: "fabric-frame:call-result",
				requestId: relayId,
				ok: true,
				result: "forged",
			},
			window.location.origin,
		);
		messageFrom(
			iframe.contentWindow,
			{
				type: "fabric-frame:call-result",
				requestId: relayId,
				ok: true,
				result: "forged by the page itself",
			},
			window.location.origin,
		);

		expect(toPage).not.toHaveBeenCalled();
		stranger.remove();
	});

	it("ignores an answer for a call it never relayed", () => {
		const { toPage } = setup();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: "relay-never-sent",
			ok: true,
			result: "stray",
		});

		expect(toPage).not.toHaveBeenCalled();
	});
});

describe("relay request lifetime", () => {
	it("rejects expired admission and late host replies without waiting for a delayed timer", () => {
		vi.useFakeTimers();
		const view = setup();
		const transportTimers = vi.getTimerCount();
		messageFrom(view.iframe.contentWindow, {
			...pageCall("already-expired"),
			expiresAt: Date.now() - 1,
		});
		expect(toHost).toEqual([]);
		expect(vi.getTimerCount()).toBe(transportTimers);
		const relayId = view.relay();
		expect(vi.getTimerCount()).toBe(transportTimers + 1);
		vi.setSystemTime(Date.now() + FABRIC_RUNTIME_CALL_TIMEOUT_MS);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: true,
			result: "late",
		});
		expect(view.toPage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				ok: false,
				error: "Fabric did not answer",
			}),
			"*",
		);
		expect(toHost.at(-1)?.message).toEqual({
			type: "fabric-frame:cancel-call",
			requestId: relayId,
		});
		expect(vi.getTimerCount()).toBe(transportTimers);
		view.unmount();
	});

	it("translates only its own page's cancellation and preserves the absolute deadline", () => {
		vi.useFakeTimers();
		const { container, unmount } = render(
			<FrameRenderer frame={frame} embedded />,
		);
		const page = pageIframe(container).contentWindow;
		const transportTimers = vi.getTimerCount();
		const deadline = Date.now() + 1000;
		messageFrom(page, { ...pageCall(), expiresAt: deadline });
		expect(vi.getTimerCount()).toBe(transportTimers + 1);
		const call = toHost.find(
			(entry) =>
				(entry.message as { type?: string }).type ===
				"fabric-frame:call",
		)?.message as { requestId: string; expiresAt: number };
		expect(call.expiresAt).toBe(deadline);
		const cancelled = () =>
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:cancel-call",
			);
		messageFrom(window, {
			type: "fabric-frame:cancel-call",
			requestId: "call-1",
		});
		messageFrom(page, {
			type: "fabric-frame:cancel-call",
			requestId: call.requestId,
		});
		expect(cancelled()).toEqual([]);
		messageFrom(page, {
			type: "fabric-frame:cancel-call",
			requestId: "call-1",
		});
		expect(cancelled()).toEqual([
			{
				message: {
					type: "fabric-frame:cancel-call",
					requestId: call.requestId,
				},
				targetOrigin: window.location.origin,
			},
		]);
		expect(vi.getTimerCount()).toBe(transportTimers);
		unmount();
	});

	it("cannot cancel a sibling iframe's matching page ID or relay ID", () => {
		const { container, unmount } = render(
			<FrameRenderer
				frame={{
					...frame,
					blocks: [
						frame.blocks[0],
						{ ...frame.blocks[0], id: "second" },
					],
				}}
				embedded
			/>,
		);
		const pages = container.querySelectorAll<HTMLIFrameElement>(
			'iframe[data-frame-scope="project"]',
		);
		messageFrom(pages[0].contentWindow!, pageCall());
		messageFrom(pages[1].contentWindow!, pageCall());
		const calls = toHost
			.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:call",
			)
			.map((entry) => entry.message as { requestId: string });
		messageFrom(pages[1].contentWindow!, {
			type: "fabric-frame:cancel-call",
			requestId: calls[0].requestId,
		});
		expect(
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:cancel-call",
			),
		).toEqual([]);
		messageFrom(pages[1].contentWindow!, {
			type: "fabric-frame:cancel-call",
			requestId: "call-1",
		});
		expect(toHost.at(-1)?.message).toEqual({
			type: "fabric-frame:cancel-call",
			requestId: calls[1].requestId,
		});
		unmount();
	});

	function setup() {
		const view = render(<FrameRenderer frame={frame} embedded />);
		const iframe = pageIframe(view.container);
		const toPage = vi
			.spyOn(iframe.contentWindow, "postMessage")
			.mockImplementation(() => {});
		const relay = (requestId = "call-1") => {
			messageFrom(
				pageIframe(view.container).contentWindow,
				pageCall(requestId),
			);
			const entry = toHost
				.filter(
					(item) =>
						(item.message as { type?: string }).type ===
						"fabric-frame:call",
				)
				.at(-1);
			return (entry?.message as { requestId: string }).requestId;
		};
		return { ...view, iframe, toPage, relay };
	}

	it("expires lost replies and frees the relay budget for subsequent calls", async () => {
		vi.useFakeTimers();
		const view = setup();
		const first = view.relay();
		for (let index = 1; index < 100; index++) {
			view.relay(`call-${index + 1}`);
		}
		view.relay("overflow");
		expect(view.toPage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				ok: false,
				error: "Too many Fabric calls are waiting for an answer.",
			}),
			"*",
		);

		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);
		expect(
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:cancel-call",
			),
		).toHaveLength(100);
		expect(view.toPage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				requestId: "call-100",
				ok: false,
				error: "Fabric did not answer",
			}),
			"*",
		);
		view.toPage.mockClear();
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: first,
			ok: true,
			result: "late",
		});
		expect(view.toPage).not.toHaveBeenCalled();

		const next = view.relay();
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: next,
			ok: true,
			result: "fresh",
		});
		expect(view.toPage).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "call-1",
				ok: true,
				result: "fresh",
			}),
			"*",
		);
		view.unmount();
	});

	it("cancels old timers and cannot resolve a replacement page's reused request id", async () => {
		vi.useFakeTimers();
		const view = setup();
		const stale = view.relay();
		view.rerender(
			<FrameRenderer
				frame={{
					...frame,
					blocks: [
						{ ...frame.blocks[0], content: "<p>Edited page</p>" },
					],
				}}
				embedded
			/>,
		);
		const replacement = pageIframe(view.container);
		expect(toHost.at(-1)?.message).toEqual({
			type: "fabric-frame:cancel-call",
			requestId: stale,
		});
		expect(replacement).not.toBe(view.iframe);
		expect(view.toPage).toHaveBeenCalledWith(
			{
				type: "fabric-frame:call-result",
				requestId: "call-1",
				ok: false,
				error: "This page changed. Try again from the current version.",
			},
			"*",
		);
		const toReplacement = vi
			.spyOn(replacement.contentWindow, "postMessage")
			.mockImplementation(() => {});
		const fresh = view.relay();

		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: stale,
			ok: true,
			result: "old",
		});
		expect(toReplacement).not.toHaveBeenCalled();
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: fresh,
			ok: true,
			result: "new",
		});
		expect(toReplacement).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "call-1", result: "new" }),
			"*",
		);
		view.toPage.mockClear();
		toReplacement.mockClear();
		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);
		expect(view.toPage).not.toHaveBeenCalled();
		expect(toReplacement).not.toHaveBeenCalled();
		view.unmount();
	});

	it("answers teardown only to the originating page and leaves a sibling call live", () => {
		const sibling = { ...frame.blocks[0], id: "sibling" };
		const view = render(
			<FrameRenderer
				frame={{ ...frame, blocks: [frame.blocks[0], sibling] }}
				embedded
			/>,
		);
		const pages = view.container.querySelectorAll<HTMLIFrameElement>(
			'iframe[data-frame-scope="project"]',
		);
		const toFirst = vi
			.spyOn(pages[0].contentWindow!, "postMessage")
			.mockImplementation(() => {});
		const toSibling = vi
			.spyOn(pages[1].contentWindow!, "postMessage")
			.mockImplementation(() => {});
		messageFrom(pages[0].contentWindow!, pageCall());
		messageFrom(pages[1].contentWindow!, pageCall());
		const calls = toHost
			.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					"fabric-frame:call",
			)
			.map((entry) => entry.message as { requestId: string });
		view.rerender(
			<FrameRenderer frame={{ ...frame, blocks: [sibling] }} embedded />,
		);
		expect(toFirst).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "call-1", ok: false }),
			"*",
		);
		expect(toSibling).not.toHaveBeenCalled();
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: calls[0].requestId,
			ok: true,
			result: "old",
		});
		expect(toSibling).not.toHaveBeenCalled();
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: calls[1].requestId,
			ok: true,
			result: "sibling",
		});
		expect(toSibling).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "call-1",
				ok: true,
				result: "sibling",
			}),
			"*",
		);
		view.unmount();
	});

	it("clears pending relay timers on unmount", async () => {
		vi.useFakeTimers();
		const view = setup();
		const relayId = view.relay();
		view.unmount();
		expect(toHost.at(-1)?.message).toEqual({
			type: "fabric-frame:cancel-call",
			requestId: relayId,
		});
		view.toPage.mockClear();

		await vi.advanceTimersByTimeAsync(FABRIC_RUNTIME_CALL_TIMEOUT_MS);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: relayId,
			ok: true,
			result: "late",
		});
		expect(view.toPage).not.toHaveBeenCalled();
	});
});

describe("a page whose frame is not embedded in a Fabric view", () => {
	it("is told at once that nothing can run, and nothing is sent anywhere", () => {
		const { container } = render(<FrameRenderer frame={frame} />);
		const iframe = pageIframe(container);
		const toPage = vi
			.spyOn(iframe.contentWindow, "postMessage")
			.mockImplementation(() => {});

		messageFrom(iframe.contentWindow, pageCall("call-9"));

		expect(toPage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "fabric-frame:call-result",
				requestId: "call-9",
				ok: false,
			}),
			"*",
		);
		expect(toHost).toEqual([]);
	});

	it("sends nothing of a file the page offers either", () => {
		const { container } = render(<FrameRenderer frame={frame} />);

		messageFrom(pageIframe(container).contentWindow, {
			type: "fabric-frame:download",
			filename: "report.csv",
			mimeType: "text/csv",
			dataBase64: "AAAA",
		});

		expect(toHost).toEqual([]);
	});
});

/**
 * A page's script runs as soon as its document is parsed, which can be before
 * the embed has hydrated and attached the listener above: a request posted in
 * that gap reaches no one, and the page waits for an answer that never comes.
 * The page and the embed therefore agree on when requests may go (`host-ready`
 * from the embed, `runtime-hello` from the page), and these cases drive the real
 * page runtime against the real embed in both orders of start.
 *
 * jsdom does not run a sandboxed srcdoc, so the page's window is a stand-in
 * that the real runtime script is evaluated against. Delivery is synchronous
 * and, like a browser's, goes only to a window that is listening: what the page
 * posts before the embed is mounted finds no listener and is lost.
 */
describe("the handshake between the page and the embed", () => {
	type Listener = (event: { source: unknown; data: unknown }) => void;

	function standInPage() {
		const listeners: Listener[] = [];
		const toPage: unknown[] = [];
		const pageWindow: {
			parent: { postMessage: (message: unknown) => void };
			addEventListener: (type: string, listener: Listener) => void;
			postMessage: (message: unknown, targetOrigin: string) => void;
			fabric?: {
				call: (name: string, args?: object) => Promise<unknown>;
			};
		} = {
			parent: {
				postMessage: (message) => {
					const event = new MessageEvent("message", {
						data: message,
						origin: "null",
					});
					Object.defineProperty(event, "source", {
						value: pageWindow,
					});
					window.dispatchEvent(event);
				},
			},
			addEventListener: (type, listener) => {
				if (type === "message") {
					listeners.push(listener);
				}
			},
			postMessage: (message) => {
				toPage.push(message);
				for (const listener of listeners) {
					listener({ source: pageWindow.parent, data: message });
				}
			},
		};
		vi.spyOn(
			HTMLIFrameElement.prototype,
			"contentWindow",
			"get",
		).mockReturnValue(pageWindow as unknown as Window);
		return {
			pageWindow,
			toPage,
			start() {
				new Function("window", FABRIC_RUNTIME_SCRIPT)(pageWindow);
				const fabric = pageWindow.fabric;
				if (!fabric) {
					throw new Error("the runtime did not define window.fabric");
				}
				return fabric;
			},
		};
	}

	const relayedCalls = () =>
		toHost.filter(
			(entry) =>
				(entry.message as { type?: string }).type ===
				"fabric-frame:call",
		);

	const isHostReady = (message: unknown) =>
		(message as { type?: string }).type === FRAME_RUNTIME_HOST_READY_TYPE;

	function pageMessageFrom(source: unknown, data: unknown) {
		const event = new MessageEvent("message", { data, origin: "null" });
		Object.defineProperty(event, "source", { value: source });
		window.dispatchEvent(event);
	}

	it("answers a call the page made before the embed was listening, once the embed is mounted", async () => {
		const page = standInPage();
		const fabric = page.start();
		const result = fabric.call("fabric_list_workflows", { limit: 2 });
		expect(relayedCalls()).toEqual([]);

		render(<FrameRenderer frame={frame} embedded />);

		expect(relayedCalls()).toHaveLength(1);
		const [relayed] = relayedCalls();
		expect(relayed.message).toMatchObject({
			name: "fabric_list_workflows",
			args: { limit: 2 },
			requestId: expect.stringMatching(/^relay-/),
		});
		expect(relayed.targetOrigin).toBe(window.location.origin);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: (relayed.message as { requestId: string }).requestId,
			ok: true,
			result: { workflows: ["w1"] },
		});
		await expect(result).resolves.toEqual({ workflows: ["w1"] });
	});

	it("tells the page the embed is listening as soon as the listener is attached", () => {
		const page = standInPage();

		render(<FrameRenderer frame={frame} embedded />);

		expect(page.toPage).toEqual([{ type: FRAME_RUNTIME_HOST_READY_TYPE }]);
	});

	it("tells a page that comes up after the embed is listening, when it says hello", async () => {
		const page = standInPage();
		render(<FrameRenderer frame={frame} embedded />);
		expect(page.toPage.filter(isHostReady)).toHaveLength(1);

		const fabric = page.start();

		expect(page.toPage.filter(isHostReady)).toHaveLength(2);
		const result = fabric.call("fabric_get_frame", { frameId: "f1" });
		expect(relayedCalls()).toHaveLength(1);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: (relayedCalls()[0].message as { requestId: string })
				.requestId,
			ok: true,
			result: "frame",
		});
		await expect(result).resolves.toBe("frame");
	});

	it("sends a held call up once, however many times the embed says it is listening", async () => {
		const page = standInPage();
		const fabric = page.start();
		const result = fabric.call("fabric_list_workflows");
		const { rerender } = render(<FrameRenderer frame={frame} embedded />);
		expect(relayedCalls()).toHaveLength(1);

		pageMessageFrom(page.pageWindow, { type: FRAME_RUNTIME_HELLO_TYPE });
		pageMessageFrom(page.pageWindow, { type: FRAME_RUNTIME_HELLO_TYPE });
		rerender(<FrameRenderer frame={frame} embedded />);

		expect(page.toPage.filter(isHostReady).length).toBeGreaterThan(2);
		expect(relayedCalls()).toHaveLength(1);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: (relayedCalls()[0].message as { requestId: string })
				.requestId,
			ok: true,
			result: "once",
		});
		await expect(result).resolves.toBe("once");
	});

	it("rejects a held call when its host disappears and keeps a replacement call separate", async () => {
		const page = standInPage();
		const fabric = page.start();
		const result = fabric.call("fabric_list_workflows");
		const rejected = expect(result).rejects.toThrow(
			"not open in a Fabric view",
		);
		const { rerender } = render(<FrameRenderer frame={frame} embedded />);
		const oldRelay = (relayedCalls()[0].message as { requestId: string })
			.requestId;
		rerender(<FrameRenderer frame={frame} />);
		await rejected;
		expect(toHost.at(-1)?.message).toEqual({
			type: "fabric-frame:cancel-call",
			requestId: oldRelay,
		});
		rerender(<FrameRenderer frame={frame} embedded />);
		const fresh = fabric.call("fabric_list_workflows");
		const freshRelay = (relayedCalls()[1].message as { requestId: string })
			.requestId;
		expect(freshRelay).not.toBe(oldRelay);
		const repliesBefore = page.toPage.length;
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: oldRelay,
			ok: true,
			result: "old",
		});
		expect(page.toPage).toHaveLength(repliesBefore);
		hostAnswers({
			type: "fabric-frame:call-result",
			requestId: freshRelay,
			ok: true,
			result: "fresh",
		});
		await expect(fresh).resolves.toBe("fresh");
	});

	it("does not answer a hello that is not from the page's own iframe", () => {
		const page = standInPage();
		render(<FrameRenderer frame={frame} embedded />);
		const before = page.toPage.length;

		pageMessageFrom(
			{ another: "window" },
			{ type: FRAME_RUNTIME_HELLO_TYPE },
		);
		pageMessageFrom(window, { type: FRAME_RUNTIME_HELLO_TYPE });
		pageMessageFrom(null, { type: FRAME_RUNTIME_HELLO_TYPE });
		hostAnswers({ type: FRAME_RUNTIME_HELLO_TYPE });

		expect(page.toPage).toHaveLength(before);
	});

	it("does not pass a hello on to the host", () => {
		const page = standInPage();
		render(<FrameRenderer frame={frame} embedded />);

		pageMessageFrom(page.pageWindow, { type: FRAME_RUNTIME_HELLO_TYPE });

		expect(
			toHost.filter(
				(entry) =>
					(entry.message as { type?: string }).type ===
					FRAME_RUNTIME_HELLO_TYPE,
			),
		).toEqual([]);
	});

	it("lets a page whose frame is not embedded find out at once that nothing can run", async () => {
		const page = standInPage();
		const fabric = page.start();
		const result = fabric.call("fabric_list_workflows");
		const settled = expect(result).rejects.toThrow(
			"not open in a Fabric view",
		);

		render(<FrameRenderer frame={frame} />);

		await settled;
		expect(relayedCalls()).toEqual([]);
	});
});
