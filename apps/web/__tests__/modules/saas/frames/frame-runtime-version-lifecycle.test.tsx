import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	listTools: vi.fn(),
	viewing: { organizationId: "org-a" as string | null },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => mocks.viewing.organizationId,
}));
vi.mock("@saas/mcp/lib/fabric-tool-client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/fabric-tool-client")
	>()),
	callFabricTool: mocks.callTool,
	listFabricTools: mocks.listTools,
}));

import {
	type FrameRuntimeBridgeOptions,
	useFrameRuntimeBridge,
} from "@saas/frames/hooks/use-frame-runtime-bridge";
import { FRAME_RUNTIME_CALL_TIMEOUT_MS } from "@saas/frames/lib/frame-embed-protocol";

let sequence = 0;
let iframe: HTMLIFrameElement;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.viewing.organizationId = "org-a";
	mocks.listTools.mockResolvedValue([
		{ name: "fabric_execute_workflow" },
		{ name: "fabric_pause_workflow" },
		{ name: "fabric_list_workflows", annotations: { readOnlyHint: true } },
	]);
	mocks.callTool.mockResolvedValue({ ok: true });
	iframe = document.createElement("iframe");
	document.body.appendChild(iframe);
});

afterEach(() => {
	iframe.remove();
	vi.useRealTimers();
});

function setup(overrides: Partial<FrameRuntimeBridgeOptions> = {}) {
	sequence += 1;
	const options: FrameRuntimeBridgeOptions = {
		frameKey: `version-lifecycle-${sequence}`,
		frameId: `frame-${sequence}`,
		contentVersion: "original content",
		contentFingerprint: "original-digest",
		organizationId: "org-a",
		runtimeTools: [
			"fabric_execute_workflow",
			"fabric_pause_workflow",
			"fabric_list_workflows",
		],
		embedWindows: () => [iframe.contentWindow],
		embedUrl: "/app/example-org/frames/example/embed",
		enabled: true,
		...overrides,
	};
	const view = renderHook(useFrameRuntimeBridge, { initialProps: options });
	const send = (
		requestId: string,
		name = "fabric_execute_workflow",
		args: Record<string, unknown> = {},
		expiresAt?: number,
	) => {
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
						expiresAt,
					},
				}),
			);
		});
	};
	const cancel = (requestId: string, source = iframe.contentWindow) => {
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source,
					data: { type: "fabric-frame:cancel-call", requestId },
				}),
			),
		);
	};
	const answer = async () => {
		await waitFor(() =>
			expect(view.result.current.pendingCall).not.toBeNull(),
		);
		act(() => view.result.current.answerConfirmation(true));
	};
	return { ...view, options, send, answer, cancel };
}

async function flushCalls() {
	await act(async () => {});
}

describe("page-version ownership of consent and execution", () => {
	it("cancels an active question, advances the next and rejects a captured stale Allow", async () => {
		const view = setup();
		view.send("first", "fabric_execute_workflow", { marker: "first" });
		await flushCalls();
		const staleAllow = view.result.current.answerConfirmation;
		view.send("second", "fabric_pause_workflow", { marker: "second" });
		await flushCalls();
		view.cancel("first");
		await flushCalls();
		expect(view.result.current.pendingCall).toMatchObject({
			args: { marker: "second" },
		});
		act(() => staleAllow(true));
		expect(mocks.callTool).not.toHaveBeenCalled();
		await view.answer();
		await flushCalls();
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		view.send("first-again", "fabric_execute_workflow", {
			marker: "fresh",
		});
		await flushCalls();
		expect(view.result.current.pendingCall).toMatchObject({
			args: { marker: "fresh" },
		});
		view.unmount();
	});

	it("frees cancelled queued question budget once and allows successors", async () => {
		const view = setup();
		view.send("active");
		for (let index = 0; index < 4; index++) {
			view.send(`queued-${index}`);
		}
		await flushCalls();
		for (let index = 0; index < 4; index++) {
			view.cancel(`queued-${index}`);
			view.cancel(`queued-${index}`);
		}
		await flushCalls();
		for (let index = 0; index < 4; index++) {
			view.send(`new-${index}`, "fabric_pause_workflow", { index });
		}
		await flushCalls();
		view.cancel("active");
		await flushCalls();
		expect(view.result.current.pendingCall).toMatchObject({
			args: { index: 0 },
		});
		for (let index = 0; index < 4; index++) {
			expect(view.result.current.pendingCall).toMatchObject({
				args: { index },
			});
			view.cancel(`new-${index}`);
			await flushCalls();
		}
		expect(view.result.current.pendingCall).toBeNull();
		expect(mocks.callTool).not.toHaveBeenCalled();
		view.unmount();
	});

	it("isolates matching IDs from two embeds and rejects foreign cancellation", async () => {
		const sibling = document.createElement("iframe");
		document.body.appendChild(sibling);
		const view = setup({
			embedWindows: () => [iframe.contentWindow, sibling.contentWindow],
		});
		view.send("same-id", "fabric_execute_workflow", { embed: "first" });
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source: sibling.contentWindow,
					data: {
						type: "fabric-frame:call",
						requestId: "same-id",
						name: "fabric_execute_workflow",
						args: { embed: "sibling" },
					},
				}),
			),
		);
		await flushCalls();
		view.cancel("same-id", window);
		view.cancel("same-id", sibling.contentWindow);
		await flushCalls();
		expect(view.result.current.pendingCall).toMatchObject({
			args: { embed: "first" },
		});
		view.cancel("same-id");
		await flushCalls();
		expect(view.result.current.pendingCall).toBeNull();
		view.send("same-id", "fabric_execute_workflow", {
			embed: "replacement",
		});
		await flushCalls();
		expect(view.result.current.pendingCall).toMatchObject({
			args: { embed: "replacement" },
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
		view.unmount();
		sibling.remove();
	});

	it("dismisses an expired question and never remembers delayed consent", async () => {
		vi.useFakeTimers();
		const toEmbed = vi
			.spyOn(iframe.contentWindow!, "postMessage")
			.mockImplementation(() => {});
		const view = setup();
		view.send("expired", "fabric_execute_workflow", {}, Date.now() + 100);
		await flushCalls();
		const lateAllow = view.result.current.answerConfirmation;
		vi.setSystemTime(Date.now() + 100);
		act(() => lateAllow(true));
		await flushCalls();
		expect(view.result.current.pendingCall).toBeNull();
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(toEmbed).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "expired", ok: false }),
			window.location.origin,
		);
		view.send("fresh");
		await flushCalls();
		expect(view.result.current.pendingCall).not.toBeNull();
		view.unmount();
		await flushCalls();
		expect(vi.getTimerCount()).toBe(0);
		toEmbed.mockRestore();
	});

	it("expires unresolved metadata, clears timers and refuses a late lookup", async () => {
		vi.useFakeTimers();
		let finish!: (tools: unknown[]) => void;
		mocks.listTools.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const toEmbed = vi
			.spyOn(iframe.contentWindow!, "postMessage")
			.mockImplementation(() => {});
		const view = setup();
		view.send(
			"waiting",
			"fabric_list_workflows",
			{},
			Date.now() + FRAME_RUNTIME_CALL_TIMEOUT_MS * 10,
		);
		await flushCalls();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(FRAME_RUNTIME_CALL_TIMEOUT_MS);
		});
		expect(toEmbed).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "waiting", ok: false }),
			window.location.origin,
		);
		finish([
			{
				name: "fabric_list_workflows",
				annotations: { readOnlyHint: true },
			},
		]);
		await flushCalls();
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(view.result.current.pendingCall).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		view.unmount();
		toEmbed.mockRestore();
	});

	it("automatically expires an active question and then shows a live queued question", async () => {
		vi.useFakeTimers();
		const toEmbed = vi
			.spyOn(iframe.contentWindow!, "postMessage")
			.mockImplementation(() => {});
		const view = setup();
		view.send(
			"expires-first",
			"fabric_execute_workflow",
			{},
			Date.now() + 100,
		);
		view.send("still-live", "fabric_pause_workflow");
		await flushCalls();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect(view.result.current.pendingCall).toMatchObject({
			toolName: "fabric_pause_workflow",
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(toEmbed).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "expires-first", ok: false }),
			window.location.origin,
		);
		view.unmount();
		await flushCalls();
		expect(vi.getTimerCount()).toBe(0);
		toEmbed.mockRestore();
	});

	it.each([null, "org-b"])(
		"retains external-read taint across org A → %s → A for the surviving page",
		async (otherOrganization) => {
			mocks.listTools.mockResolvedValue([
				{ name: "fabric_page_data_set" },
				{
					name: "fabric_get_page_viewer",
					annotations: { readOnlyHint: true },
				},
			]);
			const view = setup({
				runtimeTools: [
					"fabric_page_data_set",
					"fabric_get_page_viewer",
				],
			});
			const pageWindow = iframe.contentWindow;
			const records = {
				collection: "votes",
				records: [{ key: "choice", value: { pick: "a" } }],
			};
			view.send("initial-write", "fabric_page_data_set", records);
			await view.answer();
			await waitFor(() =>
				expect(mocks.callTool).toHaveBeenCalledTimes(1),
			);
			view.send("remembered-write", "fabric_page_data_set", records);
			await waitFor(() =>
				expect(mocks.callTool).toHaveBeenCalledTimes(2),
			);
			expect(view.result.current.pendingCall).toBeNull();

			view.send("external-read", "fabric_get_page_viewer");
			await waitFor(() =>
				expect(mocks.callTool).toHaveBeenCalledTimes(3),
			);
			mocks.viewing.organizationId = otherOrganization;
			view.rerender(view.options);
			mocks.viewing.organizationId = "org-a";
			view.rerender(view.options);
			expect(iframe.contentWindow).toBe(pageWindow);

			for (let write = 0; write < 2; write++) {
				const changed = {
					...records,
					records: [
						{ key: "choice", value: { pick: `new-${write}` } },
					],
				};
				view.send(
					`fresh-write-${write}`,
					"fabric_page_data_set",
					changed,
				);
				await waitFor(() =>
					expect(view.result.current.pendingCall).toMatchObject({
						kind: "tool",
						toolName: "fabric_page_data_set",
						because: "tainted",
						args: changed,
					}),
				);
				expect(mocks.callTool).toHaveBeenCalledTimes(3 + write);
				await view.answer();
				await waitFor(() =>
					expect(mocks.callTool).toHaveBeenCalledTimes(4 + write),
				);
			}
		},
	);

	it("keeps a question through initial fingerprint hydration and remembers only that version", async () => {
		const view = setup({ contentFingerprint: null });
		view.send("first");
		await waitFor(() =>
			expect(view.result.current.pendingCall).not.toBeNull(),
		);
		view.rerender({
			...view.options,
			contentFingerprint: "resolved-digest",
		});
		await view.answer();
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
		view.send("second");
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(2));
		expect(view.result.current.pendingCall).toBeNull();
	});

	it("cancels open and queued questions after an edit, and requires fresh consent", async () => {
		const view = setup();
		view.send("old-open");
		await waitFor(() =>
			expect(view.result.current.pendingCall).not.toBeNull(),
		);
		const staleAnswer = view.result.current.answerConfirmation;
		view.send("old-queued", "fabric_pause_workflow");
		view.rerender({
			...view.options,
			contentVersion: "edited content",
			contentFingerprint: "edited-digest",
		});
		await act(async () => {});
		expect(view.result.current.pendingCall).toBeNull();
		expect(mocks.callTool).not.toHaveBeenCalled();

		view.send("fresh");
		await waitFor(() =>
			expect(view.result.current.pendingCall).not.toBeNull(),
		);
		act(() => staleAnswer(true));
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(view.result.current.pendingCall).not.toBeNull();
		await view.answer();
		await waitFor(() => expect(mocks.callTool).toHaveBeenCalledTimes(1));
		expect(mocks.callTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{},
			{ organizationId: "org-a", pageFrameId: view.options.frameId },
		);
	});

	it.each(["frame", "organization", "viewer", "unmount"])(
		"cancels every queued question when the %s scope ends",
		async (boundary) => {
			const view = setup();
			view.send("first");
			await waitFor(() =>
				expect(view.result.current.pendingCall).not.toBeNull(),
			);
			const answer = view.result.current.answerConfirmation;
			view.send("queued", "fabric_pause_workflow");
			if (boundary === "unmount") {
				view.unmount();
			} else {
				if (boundary === "viewer") {
					mocks.viewing.organizationId = "org-b";
				}
				view.rerender({
					...view.options,
					...(boundary === "frame"
						? { frameId: "other-frame", frameKey: "other-frame" }
						: {}),
					...(boundary === "organization"
						? { organizationId: "org-b" }
						: {}),
				});
			}
			await act(async () => answer(true));
			expect(mocks.callTool).not.toHaveBeenCalled();
			if (boundary !== "unmount") {
				expect(view.result.current.pendingCall).toBeNull();
			}
		},
	);

	it("does not execute a read whose tool lookup finishes after replacement", async () => {
		let finishLookup:
			| ((
					tools: Array<{
						name: string;
						annotations: { readOnlyHint: boolean };
					}>,
			  ) => void)
			| undefined;
		mocks.listTools.mockReturnValueOnce(
			new Promise((resolve) => {
				finishLookup = resolve;
			}),
		);
		const view = setup();
		view.send("old-read", "fabric_list_workflows");
		await waitFor(() => expect(mocks.listTools).toHaveBeenCalledTimes(1));
		view.rerender({
			...view.options,
			contentVersion: "replacement",
			contentFingerprint: "replacement-digest",
		});
		await act(async () => {
			finishLookup?.([
				{
					name: "fabric_list_workflows",
					annotations: { readOnlyHint: true },
				},
			]);
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(view.result.current.pendingCall).toBeNull();
	});
});
