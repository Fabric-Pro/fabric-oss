/**
 * Tests for `useInsertDiagramAction` -- the button state machine
 * (D1 / spec § 8.2, FR-1, FR-2, FR-9, FR-10, § 11).
 *
 * Coverage matrix:
 *   - Happy path -- click triggers createFromChat, editor.insertContentAt,
 *     telemetry fires, query invalidation runs, status flips to "inserted".
 *   - FORBIDDEN error -- telemetry `forbidden`, toast.error, status back
 *     to "idle".
 *   - DB error -- telemetry `db`, toast.error, status back to "idle".
 *   - Editor insert returns false -- telemetry `editor`, status flips
 *     to "error" (banner state), Diagram row preserved.
 *   - Re-click in "inserted" with embed present -- scrollIntoView,
 *     NO second createFromChat.
 *   - Re-click in "inserted" when embed was deleted -- reinsert with
 *     SAME saved row, no new createFromChat.
 *   - Concurrent double-click -- single-flight guard suppresses the
 *     second invocation.
 *   - Retry from "error" -- runs FR-2 only, no second createFromChat.
 *   - copyEmbedCode -- writes the spec-locked template via
 *     navigator.clipboard.
 *   - copyEmbedCode failure -- toast + telemetry.
 *
 * Mocks: sonner toast, orpc client, analytics shim, useTranslations.
 * The TipTap editor is a hand-crafted fake -- we exercise only the
 * commands the hook calls.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks -- must be defined BEFORE the import of the hook under test so
// Vitest's hoisting picks them up.
// ---------------------------------------------------------------------------

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
	}),
}));

const createFromChat = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			diagrams: {
				createFromChat: (...args: unknown[]) => createFromChat(...args),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			diagrams: {
				list: {
					queryKey: (input: unknown) => [
						"orpc",
						"diagrams.list",
						input,
					],
				},
			},
		},
	},
}));

const trackEvent = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, string>) => {
			switch (key) {
				case "toastSuccess":
					return `Diagram inserted into ${values?.docName}`;
				case "toastSuccessAction":
					return "Go to embed";
				case "toastErrorDb":
					return "Couldn't save diagram. Try again.";
				case "toastErrorForbidden":
					return "This feature isn't available in your workspace yet.";
				case "toastCopyFailed":
					return "Copy failed — your browser blocked clipboard access.";
				default:
					return key;
			}
		};
		return t;
	},
}));

// findEmbedNodeByConfigId is a pure helper but we mock it so the test
// can drive the FR-9 idempotency branches deterministically without
// constructing a real ProseMirror doc.
const findEmbedNodeByConfigIdMock = vi.fn();
vi.mock("../findEmbedNodeByConfigId", () => ({
	findEmbedNodeByConfigId: (...args: unknown[]) =>
		findEmbedNodeByConfigIdMock(...args),
}));

// Import AFTER all mocks so the hook sees the stubs.
const { useInsertDiagramAction } = await import("../useInsertDiagramAction");

import type { ResolverTarget } from "../types";
import type {
	InsertDiagramToolResult,
	UseInsertDiagramActionOptions,
} from "../useInsertDiagramAction";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeEditor extends Editor {
	__commands: {
		insertContentAt: ReturnType<typeof vi.fn>;
		focus: ReturnType<typeof vi.fn>;
		scrollIntoView: ReturnType<typeof vi.fn>;
		setNodeSelection: ReturnType<typeof vi.fn>;
	};
	__chainScrollIntoView: ReturnType<typeof vi.fn>;
}

function makeFakeEditor(opts: { insertSucceeds: boolean }): FakeEditor {
	const insertContentAt = vi.fn(() => opts.insertSucceeds);
	const focus = vi.fn();
	const scrollIntoView = vi.fn();
	const setNodeSelection = vi.fn();
	const chainScrollIntoView = vi.fn();
	const chainRun = vi.fn(() => true);
	const chain = vi.fn(() => ({
		setNodeSelection: vi.fn(() => ({
			scrollIntoView: () => ({
				run: chainRun,
			}),
		})),
	}));

	// Chain implementation expanded so the hook's
	// editor.chain().setNodeSelection(pos).scrollIntoView().run() works.
	const chainImpl = () => {
		const c: Record<string, unknown> = {};
		c.setNodeSelection = (pos: number) => {
			setNodeSelection(pos);
			return c;
		};
		c.scrollIntoView = () => {
			chainScrollIntoView();
			return c;
		};
		c.run = chainRun;
		return c;
	};
	chain.mockImplementation(chainImpl);

	const fake: Partial<FakeEditor> = {
		state: { doc: { content: { size: 42 } } } as unknown as Editor["state"],
		commands: {
			insertContentAt,
			focus,
			scrollIntoView,
			setNodeSelection,
		} as unknown as Editor["commands"],
		chain: chain as unknown as Editor["chain"],
		__commands: {
			insertContentAt,
			focus,
			scrollIntoView,
			setNodeSelection,
		},
		__chainScrollIntoView: chainScrollIntoView,
	};
	return fake as FakeEditor;
}

function buildToolResult(
	overrides: Partial<InsertDiagramToolResult> = {},
): InsertDiagramToolResult {
	return {
		elements: [{ type: "rectangle" }],
		appState: { gridSize: 20 },
		checkpointId: "cp_123",
		mcpConfigId: "cfg_456",
		resourceUri: "ui://excalidraw/abc",
		...overrides,
	};
}

function buildResolverTarget(editor: FakeEditor): ResolverTarget {
	return {
		kind: "document",
		editor,
		projectId: "proj_1",
		documentLabel: "Architecture spec",
		documentId: "doc_1",
	};
}

function makeWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
	const invalidate = vi.spyOn(queryClient, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
	return { wrapper, invalidate };
}

function buildOptions(
	overrides: Partial<UseInsertDiagramActionOptions> = {},
): UseInsertDiagramActionOptions {
	const editor = makeFakeEditor({ insertSucceeds: true });
	return {
		surface: "in-document",
		chatMessageId: "msg_1",
		projectId: "proj_1",
		organizationId: "org_1",
		title: "Build the dashboard",
		resolverTarget: buildResolverTarget(editor),
		toolResult: buildToolResult(),
		...overrides,
	};
}

beforeEach(() => {
	toastSuccess.mockReset();
	toastError.mockReset();
	createFromChat.mockReset();
	trackEvent.mockReset();
	findEmbedNodeByConfigIdMock.mockReset();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- happy path (FR-1 + FR-2)", () => {
	it("creates the diagram, inserts at end-of-doc, fires telemetry, invalidates list", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_123",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper, invalidate } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		expect(result.current.status).toBe("idle");
		expect(result.current.enabled).toBe(true);

		await act(async () => {
			await result.current.click();
		});

		// createFromChat called with the exact payload.
		expect(createFromChat).toHaveBeenCalledTimes(1);
		expect(createFromChat).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			elements: options.toolResult.elements,
			appState: options.toolResult.appState,
			checkpointId: "cp_123",
			mcpConfigId: "cfg_456",
			title: "Build the dashboard",
			surface: "in-document",
			sourceMessageId: "msg_1",
		});

		// insertContentAt called with end-of-doc position + the four
		// spec-locked data-attrs.
		expect(editor.__commands.insertContentAt).toHaveBeenCalledTimes(1);
		const [pos, html] = editor.__commands.insertContentAt.mock.calls[0];
		expect(pos).toBe(42); // editor.state.doc.content.size
		expect(html).toContain("<excalidraw-embed");
		expect(html).toContain('data-resource-uri="ui://excalidraw/abc"');
		expect(html).toContain('data-config-id="cfg_456"');
		expect(html).toContain('data-checkpoint-id="cp_123"');
		expect(html).toContain('data-organization-id="org_1"');

		// Focus + scroll fire AFTER insertion.
		expect(editor.__commands.focus).toHaveBeenCalledWith("end");
		expect(editor.__commands.scrollIntoView).toHaveBeenCalled();

		// Telemetry fires with spec § 12's exact properties.
		expect(trackEvent).toHaveBeenCalledWith("diagram_auto_inserted", {
			surface: "in-document",
			targetKind: "document",
			projectId: "proj_1",
			diagramId: "diag_123",
			organizationId: "org_1",
		});

		// Query invalidation runs.
		expect(invalidate).toHaveBeenCalled();

		// Success toast fires with the doc name.
		expect(toastSuccess).toHaveBeenCalledTimes(1);
		const [successMessage] = toastSuccess.mock.calls[0];
		expect(successMessage).toBe("Diagram inserted into Architecture spec");

		expect(result.current.status).toBe("inserted");
		expect(result.current.savedDiagram?.id).toBe("diag_123");
	});
});

// ---------------------------------------------------------------------------
// FR-1 failure -- FORBIDDEN
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- FORBIDDEN failure (spec § 11 row 2)", () => {
	it("fires forbidden telemetry, toasts, returns to idle", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		const forbidden = Object.assign(new Error("denied"), {
			code: "FORBIDDEN",
		});
		createFromChat.mockRejectedValueOnce(forbidden);

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.click();
		});

		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_auto_insert_failed",
			expect.objectContaining({
				surface: "in-document",
				failureClass: "forbidden",
			}),
		);
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0][0]).toBe(
			"This feature isn't available in your workspace yet.",
		);
		// Editor was never asked to insert.
		expect(editor.__commands.insertContentAt).not.toHaveBeenCalled();
		expect(result.current.status).toBe("idle");
	});
});

// ---------------------------------------------------------------------------
// FR-1 failure -- generic DB error
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- DB failure (spec § 11 row 3)", () => {
	it("fires db telemetry, toasts, returns to idle, retry-able", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat
			.mockRejectedValueOnce(
				Object.assign(new Error("boom"), {
					code: "INTERNAL_SERVER_ERROR",
				}),
			)
			.mockResolvedValueOnce({
				diagram: {
					id: "diag_999",
					mcpConfigId: "cfg_456",
					checkpointId: "cp_123",
					organizationId: "org_1",
				},
			});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		// First click -- db failure.
		await act(async () => {
			await result.current.click();
		});
		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_auto_insert_failed",
			expect.objectContaining({ failureClass: "db" }),
		);
		expect(toastError).toHaveBeenCalledWith(
			"Couldn't save diagram. Try again.",
		);
		expect(result.current.status).toBe("idle");

		// Second click -- success.
		await act(async () => {
			await result.current.click();
		});
		expect(createFromChat).toHaveBeenCalledTimes(2);
		expect(result.current.status).toBe("inserted");
	});
});

// ---------------------------------------------------------------------------
// FR-2 failure -- editor.insertContentAt returns false
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- editor failure (spec § 11 row 4)", () => {
	it("preserves diagram row, flips to error state, fires editor telemetry", async () => {
		const editor = makeFakeEditor({ insertSucceeds: false });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_e1",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.click();
		});

		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_auto_insert_failed",
			expect.objectContaining({ failureClass: "editor" }),
		);
		expect(result.current.status).toBe("error");
		// Diagram row preserved for retry.
		expect(result.current.savedDiagram?.id).toBe("diag_e1");

		// The success telemetry does NOT fire when the editor leg fails.
		const successCalls = trackEvent.mock.calls.filter(
			(call) => call[0] === "diagram_auto_inserted",
		);
		expect(successCalls).toHaveLength(0);
	});

	it("retry runs FR-2 only -- no second createFromChat", async () => {
		// Editor fails on first insert; on the retry leg we swap it to
		// succeed by replacing the implementation.
		const editor = makeFakeEditor({ insertSucceeds: false });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_retry",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.click();
		});
		expect(result.current.status).toBe("error");

		// Now make the editor succeed and retry.
		editor.__commands.insertContentAt.mockReturnValue(true);
		await act(async () => {
			await result.current.retry();
		});

		// createFromChat was only called once (no second create).
		expect(createFromChat).toHaveBeenCalledTimes(1);
		// insertContentAt was called twice -- the initial fail + the retry.
		expect(editor.__commands.insertContentAt).toHaveBeenCalledTimes(2);
		expect(result.current.status).toBe("inserted");
	});
});

// ---------------------------------------------------------------------------
// FR-9 -- idempotent re-click
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- FR-9 idempotent re-click", () => {
	it("scrolls to the existing embed when re-clicked in inserted state", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_idem",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.click();
		});
		expect(result.current.status).toBe("inserted");

		// Embed is still present in the doc.
		findEmbedNodeByConfigIdMock.mockReturnValue({
			pos: 17,
			node: {} as unknown,
		});

		await act(async () => {
			await result.current.click();
		});

		// No second createFromChat. Editor was asked to scroll the
		// existing node into view.
		expect(createFromChat).toHaveBeenCalledTimes(1);
		expect(findEmbedNodeByConfigIdMock).toHaveBeenCalledWith(
			editor,
			"cfg_456",
		);
		expect(editor.__commands.setNodeSelection).toHaveBeenCalledWith(17);

		// `diagram_auto_inserted` does NOT fire a second time.
		const successCalls = trackEvent.mock.calls.filter(
			(call) => call[0] === "diagram_auto_inserted",
		);
		expect(successCalls).toHaveLength(1);
	});

	it("re-inserts the SAME saved row when embed was deleted", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_re",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.click();
		});

		// Simulate manual delete -- the lookup returns null.
		findEmbedNodeByConfigIdMock.mockReturnValue(null);

		await act(async () => {
			await result.current.click();
		});

		// createFromChat NOT called again (FR-9 reinsert reuses the row).
		expect(createFromChat).toHaveBeenCalledTimes(1);
		// insertContentAt called twice -- once for the original insert,
		// once for the reinsert path.
		expect(editor.__commands.insertContentAt).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Single-flight guard
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- concurrent double-click", () => {
	it("only invokes createFromChat once for two simultaneous clicks", async () => {
		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});

		let resolveCreate!: (value: unknown) => void;
		createFromChat.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveCreate = resolve;
				}),
		);

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		// Two clicks back to back -- the second must be a no-op while
		// the first is in flight.
		await act(async () => {
			const p1 = result.current.click();
			const p2 = result.current.click();
			resolveCreate({
				diagram: {
					id: "diag_double",
					mcpConfigId: "cfg_456",
					checkpointId: "cp_123",
					organizationId: "org_1",
				},
			});
			await Promise.all([p1, p2]);
		});

		expect(createFromChat).toHaveBeenCalledTimes(1);
		expect(result.current.status).toBe("inserted");
	});
});

// ---------------------------------------------------------------------------
// FR-10 -- copyEmbedCode
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- copyEmbedCode (FR-10)", () => {
	it("writes the spec-locked template via navigator.clipboard.writeText", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		const options = buildOptions();
		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.copyEmbedCode();
		});

		// Spec § 17: ONLY the two server-validated cuids land in the
		// template -- no resource URI, no org id, no title.
		expect(writeText).toHaveBeenCalledTimes(1);
		const payload = writeText.mock.calls[0][0];
		expect(payload).toBe(
			'<excalidraw-embed data-config-id="cfg_456" data-checkpoint-id="cp_123"></excalidraw-embed>',
		);

		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_embed_code_copied",
			expect.objectContaining({
				surface: "in-document",
				projectId: "proj_1",
			}),
		);
	});

	it("falls back to execCommand and toasts on clipboard failure", async () => {
		const writeText = vi
			.fn()
			.mockRejectedValue(new Error("clipboard blocked"));
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		// Force the execCommand fallback to also fail so we drive the
		// toast + telemetry path.
		const execCommand = vi.fn(() => false);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		const options = buildOptions();
		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await result.current.copyEmbedCode();
		});

		// Both paths were attempted before the toast fires.
		expect(writeText).toHaveBeenCalled();
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(toastError).toHaveBeenCalledWith(
			"Copy failed — your browser blocked clipboard access.",
		);
		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_embed_code_copy_failed",
			expect.objectContaining({ surface: "in-document" }),
		);
	});
});

// ---------------------------------------------------------------------------
// Render-decision gating
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- render-decision gating", () => {
	it("disables when the caller flags blockedReason", () => {
		const options = buildOptions({
			blockedReason: "cross_project",
		});
		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});
		expect(result.current.enabled).toBe(false);
		expect(result.current.blockedReason).toBe("cross_project");
	});

	it("disables when tool result is missing checkpointId or mcpConfigId", () => {
		const options = buildOptions({
			toolResult: buildToolResult({ checkpointId: "" }),
		});
		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});
		expect(result.current.enabled).toBe(false);
	});

	it("is a no-op when click runs while disabled", async () => {
		const options = buildOptions({
			blockedReason: "no_edit_permission",
		});
		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});
		await act(async () => {
			await result.current.click();
		});
		expect(createFromChat).not.toHaveBeenCalled();
		expect(result.current.status).toBe("idle");
	});
});

// ---------------------------------------------------------------------------
// Hybrid agent-emit detection — when the agent has already
// emitted `<excalidraw-embed>` inline via `write_document_local`, the hook
// detects the pre-existing embed on mount and starts in `"inserted"` state
// so the UI button becomes a scroll-to action instead of duplicating the
// embed.
// ---------------------------------------------------------------------------

describe("useInsertDiagramAction -- agent-emit detection", () => {
	it("starts in inserted state when embed already exists in editor", async () => {
		// The detection effect runs on mount; the mocked
		// findEmbedNodeByConfigId returns a match so the hook treats the
		// embed as already present.
		findEmbedNodeByConfigIdMock.mockReturnValue({
			pos: 21,
			node: {} as unknown,
		});

		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});

		const { wrapper } = makeWrapper();
		const { result } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		// Effect runs synchronously inside renderHook's commit phase; status
		// is already "inserted" by the time the hook returns to the caller.
		await act(async () => {
			// Flush any queued effect updates.
			await Promise.resolve();
		});

		expect(findEmbedNodeByConfigIdMock).toHaveBeenCalledWith(
			editor,
			"cfg_456",
		);
		expect(result.current.status).toBe("inserted");
		// savedDiagram is synthesized from the tool result (no server
		// Diagram.id because the agent-emit path bypasses createFromChat).
		expect(result.current.savedDiagram?.configId).toBe("cfg_456");
		expect(result.current.savedDiagram?.checkpointId).toBe("cp_123");
		// No createFromChat call — the row was never persisted by this
		// click path.
		expect(createFromChat).not.toHaveBeenCalled();
	});

	it("does not override inserting/inserted state if user click already happened", async () => {
		// Start with no existing embed -- effect is a no-op on mount.
		findEmbedNodeByConfigIdMock.mockReturnValue(null);

		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});
		createFromChat.mockResolvedValueOnce({
			diagram: {
				id: "diag_user_click",
				mcpConfigId: "cfg_456",
				checkpointId: "cp_123",
				organizationId: "org_1",
			},
		});

		const { wrapper } = makeWrapper();
		const { result, rerender } = renderHook(
			() => useInsertDiagramAction(options),
			{ wrapper },
		);

		// User clicks the button to insert.
		await act(async () => {
			await result.current.click();
		});
		expect(result.current.status).toBe("inserted");
		const savedAfterClick = result.current.savedDiagram;
		expect(savedAfterClick?.id).toBe("diag_user_click");

		// Now flip the detection lookup to find a match (agent emitted
		// while the user click was processing). Re-render to trigger the
		// effect.
		findEmbedNodeByConfigIdMock.mockReturnValue({
			pos: 9,
			node: {} as unknown,
		});
		rerender();
		await act(async () => {
			await Promise.resolve();
		});

		// Status stayed at "inserted" (no regression) and savedDiagram
		// kept the server-issued row id (not the synthesized one). The
		// detection telemetry must NOT fire because we never overrode
		// user-driven state.
		expect(result.current.status).toBe("inserted");
		expect(result.current.savedDiagram?.id).toBe("diag_user_click");
		expect(
			trackEvent.mock.calls.filter(
				(call) => call[0] === "diagram_auto_insert_detected_existing",
			),
		).toHaveLength(0);
	});

	it("fires diagram_auto_insert_detected_existing telemetry once", async () => {
		findEmbedNodeByConfigIdMock.mockReturnValue({
			pos: 7,
			node: {} as unknown,
		});

		const editor = makeFakeEditor({ insertSucceeds: true });
		const options = buildOptions({
			resolverTarget: buildResolverTarget(editor),
		});

		const { wrapper } = makeWrapper();
		const { rerender } = renderHook(() => useInsertDiagramAction(options), {
			wrapper,
		});

		await act(async () => {
			await Promise.resolve();
		});

		// Force a few re-renders. The detection effect re-runs but the
		// ref-guarded telemetry must only fire on the first detection.
		rerender();
		rerender();
		rerender();
		await act(async () => {
			await Promise.resolve();
		});

		const detectedCalls = trackEvent.mock.calls.filter(
			(call) => call[0] === "diagram_auto_insert_detected_existing",
		);
		expect(detectedCalls).toHaveLength(1);
		expect(detectedCalls[0][1]).toMatchObject({
			surface: "in-document",
			projectId: "proj_1",
		});
	});
});
