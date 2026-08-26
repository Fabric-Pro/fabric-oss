/**
 * Tests for `usePickerIntentConsumer` (E3 / spec § 10.4 / § 11 row 8 /
 * § 12).
 *
 * Coverage:
 *   - Matching intent triggers `action.click()` exactly once after the
 *     editor mounts.
 *   - Mismatched intent (right id, wrong target) is consumed but NEVER
 *     triggers a click.
 *   - Expired intent (older than 60s) fires
 *     `diagram_auto_insert_picker_timeout` telemetry and does NOT
 *     trigger a click.
 *   - SSR-safe -- no window/sessionStorage access happens before
 *     `editor` is non-null.
 *
 * The hook mounts `useInsertDiagramAction` internally. The real hook
 * pulls in the oRPC client + sonner + many transitive imports, so we
 * mock it here and assert directly on the synthetic `enabled` / `click`
 * spies. The unit-test purpose is the orchestration around the action,
 * not the action's own behavior (already covered by D1).
 */
import { renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (declared before the dynamic import of the SUT)
// ---------------------------------------------------------------------------

const trackEvent = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent }),
}));

const actionClick = vi.fn();
let actionEnabled = false;
const useInsertDiagramActionMock = vi.fn(() => ({
	enabled: actionEnabled,
	status: "idle" as const,
	click: actionClick,
	copyEmbedCode: vi.fn(),
	retry: vi.fn(),
}));
vi.mock("../useInsertDiagramAction", () => ({
	useInsertDiagramAction: (
		...args: Parameters<typeof useInsertDiagramActionMock>
	) => useInsertDiagramActionMock(...args),
}));

// JSDOM provides sessionStorage out of the box, but we re-declare a
// requestAnimationFrame polyfill that fires synchronously so the test
// doesn't need fake timers.
beforeEach(() => {
	trackEvent.mockReset();
	actionClick.mockReset();
	actionEnabled = false;
	useInsertDiagramActionMock.mockClear();
	window.sessionStorage.clear();
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		// Invoke synchronously for deterministic test ordering.
		cb(0);
		return 0;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const { usePickerIntentConsumer } = await import("../usePickerIntentConsumer");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeEditor(): Editor {
	return {
		on: vi.fn(),
		off: vi.fn(),
		state: { doc: { content: { size: 0 } } },
		commands: {
			insertContentAt: vi.fn(),
			focus: vi.fn(),
			scrollIntoView: vi.fn(),
		},
	} as unknown as Editor;
}

function writeIntent(
	diagramRequestId: string,
	intent: Record<string, unknown>,
): void {
	window.sessionStorage.setItem(
		`excalidraw-auto-insert:${diagramRequestId}`,
		JSON.stringify({
			diagramRequestId,
			surface: "nexus",
			projectId: "proj_1",
			organizationId: "org_1",
			elements: [{ type: "rect" }],
			appState: {},
			checkpointId: "cp_abc",
			mcpConfigId: "cfg_xyz",
			title: "Build the dashboard",
			targetKind: "document",
			targetId: "doc_1",
			createdAt: Date.now(),
			...intent,
		}),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usePickerIntentConsumer -- matching intent triggers click", () => {
	it("calls action.click() once when the intent's target matches the page", () => {
		writeIntent("req_1", {});
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: makeFakeEditor(),
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
				documentLabel: "Architecture",
			}),
		);

		// One scan -> one matching intent -> one click dispatched. The
		// effect that watches `action.enabled` fires once `useInsertDiagramAction`
		// is invoked with the populated options.
		expect(actionClick).toHaveBeenCalledTimes(1);

		// Storage entry was consumed.
		expect(
			window.sessionStorage.getItem("excalidraw-auto-insert:req_1"),
		).toBeNull();
	});

	it("does not trigger click when no editor is mounted", () => {
		writeIntent("req_solo", {});
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: null,
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
		// Intent is preserved -- the consumer didn't run.
		expect(
			window.sessionStorage.getItem("excalidraw-auto-insert:req_solo"),
		).not.toBeNull();
	});
});

describe("usePickerIntentConsumer -- mismatched intent is consumed but not triggered", () => {
	it("consumes a wrong-targetId intent without dispatching the click", () => {
		writeIntent("req_mismatch", { targetId: "doc_OTHER" });
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: makeFakeEditor(),
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
		// Defensive consume: mismatched intents are still removed so they
		// don't replay on a later page.
		expect(
			window.sessionStorage.getItem(
				"excalidraw-auto-insert:req_mismatch",
			),
		).toBeNull();
	});

	it("consumes a wrong-projectId intent without dispatching the click", () => {
		writeIntent("req_otherproj", { projectId: "proj_OTHER" });
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: makeFakeEditor(),
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
		expect(
			window.sessionStorage.getItem(
				"excalidraw-auto-insert:req_otherproj",
			),
		).toBeNull();
	});

	it("consumes a wrong-kind intent without dispatching the click", () => {
		writeIntent("req_wrongkind", {
			targetKind: "story",
			targetId: "story_1",
		});
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: makeFakeEditor(),
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
	});
});

describe("usePickerIntentConsumer -- expired intent fires timeout telemetry", () => {
	it("fires diagram_auto_insert_picker_timeout when the intent is > 60s old", () => {
		writeIntent("req_expired", {
			createdAt: Date.now() - 120_000, // 2 minutes ago.
		});
		actionEnabled = true;

		renderHook(() =>
			usePickerIntentConsumer({
				editor: makeFakeEditor(),
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_auto_insert_picker_timeout",
			expect.objectContaining({
				surface: "nexus",
				projectId: "proj_1",
			}),
		);
	});
});

describe("usePickerIntentConsumer -- SSR safety", () => {
	it("does not access window when editor is null", () => {
		// No intent written; null editor means the hook should be a
		// total no-op. We assert via the absence of side effects: no
		// click, no telemetry, no action-hook invocation with populated
		// options.
		renderHook(() =>
			usePickerIntentConsumer({
				editor: null,
				projectId: "proj_1",
				kind: "document",
				documentId: "doc_1",
			}),
		);

		expect(actionClick).not.toHaveBeenCalled();
		expect(trackEvent).not.toHaveBeenCalled();
	});
});
