/**
 * Tests for `useUpdateDocumentWithContext` (Flow B — "Update using context").
 *
 * Covers the three hardening guards:
 *   1. `start()` treats a normalized-identical preview as a no-op: it stays in
 *      the "idle" phase, shows an info toast, and never applies a diff.
 *   2. `confirm()` honors the server's `applied: false` backstop with an info
 *      toast (not a phantom success) and exits to idle.
 *   3. `confirm()` refuses to save an empty markdown extraction against a
 *      non-empty baseline: no RPC, an error toast, and the review stays open.
 *
 * We mock the oRPC client and sonner; the two pure guards stay real (they only
 * wrap the canonical comparator). Translations resolve from the shipped
 * English, so what a person reads — a refused confirm included (Fizzy #2946)
 * — is asserted as such and a missing key fails here.
 */

import en from "@repo/i18n/translations/en.json";
import { act, renderHook } from "@testing-library/react";
import type { useEditor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateWithContext, mockToast } = vi.hoisted(() => ({
	mockUpdateWithContext: vi.fn(),
	mockToast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				updateWithContext: (input: unknown) =>
					mockUpdateWithContext(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("next-intl", async () => {
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const resolve = (path: string): string => {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				messages,
			);
		if (typeof value !== "string") {
			throw new Error(`missing translation: ${path}`);
		}
		return value;
	};
	// One translator per namespace, stable across renders like next-intl's.
	const translators = new Map<
		string,
		(key: string, values?: Record<string, unknown>) => string
	>();
	return {
		useTranslations: (namespace: string) => {
			let t = translators.get(namespace);
			if (!t) {
				t = (key, values) => {
					let out = resolve(`${namespace}.${key}`);
					for (const [name, value] of Object.entries(values ?? {})) {
						out = out.replaceAll(`{${name}}`, String(value));
					}
					return out;
				};
				translators.set(namespace, t);
			}
			return t;
		},
	};
});

const COPY = en.projects.updateWithContext;
const REFUSAL_COPY = en.projects.documentWriteRefusal;

/** A refusal shaped like the client's thrown oRPC error. */
function refusal(code: string, dataCode?: string, message = "server words") {
	return Object.assign(new Error(message), {
		code,
		...(dataCode ? { data: { code: dataCode } } : {}),
	});
}

import { useUpdateDocumentWithContext } from "@saas/projects/components/documents/useUpdateDocumentWithContext";

type EditorLike = ReturnType<typeof useEditor>;

function setup(
	resolveBase?: () =>
		| { version: number; contentHash: string }
		| null
		| undefined
		| "unavailable",
) {
	const setEditable = vi.fn();
	const setContent = vi.fn();
	const editor = {
		setEditable,
		commands: { setContent },
	} as unknown as EditorLike;
	const getEditorMarkdownForSave = vi.fn((_editor: EditorLike | null) => "");
	const fromMarkdown = vi.fn((md: string) => `html:${md}`);
	const diffPartialText = vi.fn(
		(baseline: string, next: string) => `diff:${baseline}=>${next}`,
	);
	const onSaved = vi.fn();

	const { result } = renderHook(() =>
		useUpdateDocumentWithContext({
			projectId: "p1",
			documentId: "d1",
			organizationId: null,
			editor,
			getEditorMarkdownForSave,
			fromMarkdown,
			diffPartialText,
			onSaved,
			resolveBase,
		}),
	);

	return {
		result,
		setEditable,
		setContent,
		getEditorMarkdownForSave,
		diffPartialText,
		onSaved,
	};
}

beforeEach(() => {
	mockUpdateWithContext.mockReset();
	mockToast.info.mockReset();
	mockToast.success.mockReset();
	mockToast.error.mockReset();
});

describe("useUpdateDocumentWithContext.start()", () => {
	it("treats a normalized-identical preview as a no-op — info toast, no diff, editor unlocked", async () => {
		const { result, setEditable, setContent, getEditorMarkdownForSave } =
			setup();
		getEditorMarkdownForSave.mockReturnValue("# Doc\n\nBody.");
		// Server flags relevant context, but the proposed content differs only
		// in trailing whitespace — the canonical comparator collapses it to a
		// no-op.
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: "# Doc  \n\nBody.   ",
			documentVersion: 2,
		});

		await act(async () => {
			await result.current.start();
		});

		expect(mockToast.info).toHaveBeenCalledTimes(1);
		expect(setContent).not.toHaveBeenCalled();
		expect(result.current.showingDiff).toBe(false);
		expect(result.current.isActive).toBe(false);
		// Editor was locked during the RPC then unlocked on the no-op exit.
		expect(setEditable).toHaveBeenLastCalledWith(true);
	});

	it("enters the diff phase for a real change", async () => {
		const { result, setContent, getEditorMarkdownForSave } = setup();
		getEditorMarkdownForSave.mockReturnValue("# Doc");
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: "# Doc — with a real added sentence.",
			documentVersion: 4,
		});

		await act(async () => {
			await result.current.start();
		});

		expect(result.current.showingDiff).toBe(true);
		expect(setContent).toHaveBeenCalledTimes(1);
		expect(mockToast.info).not.toHaveBeenCalled();
	});
});

describe("useUpdateDocumentWithContext.confirm()", () => {
	async function enterDiffPhase(
		result: ReturnType<typeof setup>["result"],
		getEditorMarkdownForSave: ReturnType<
			typeof setup
		>["getEditorMarkdownForSave"],
		baseline: string,
	) {
		getEditorMarkdownForSave.mockReturnValueOnce(baseline);
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: `${baseline} — changed`,
			documentVersion: 4,
		});
		await act(async () => {
			await result.current.start();
		});
		expect(result.current.showingDiff).toBe(true);
	}

	it("honors applied:false with an info toast and exits to idle", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");

		// Confirm extraction succeeds (non-empty); server reports a no-op save.
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: false,
			summary: "No changes were applied — matches current.",
			documentVersion: 4,
			document: { version: 4 },
		});

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.info).toHaveBeenCalledTimes(1);
		expect(mockToast.success).not.toHaveBeenCalled();
		expect(result.current.showingDiff).toBe(false);
		expect(result.current.isActive).toBe(false);
	});

	it("shows a version-bearing success toast on applied:true", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");

		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: true,
			summary: "Context update applied successfully.",
			documentVersion: 5,
			document: { version: 5 },
		});

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.success).toHaveBeenCalledTimes(1);
		expect(mockToast.success.mock.calls[0][0]).toContain("v5");
		expect(mockToast.success).toHaveBeenCalledWith(
			COPY.applied.replace("{version}", "5"),
		);
		expect(mockToast.info).not.toHaveBeenCalled();
	});

	it("refuses to save an empty extraction — no RPC, error toast, stays in diff", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");
		// One RPC so far (the preview).
		expect(mockUpdateWithContext).toHaveBeenCalledTimes(1);

		// Extraction fails on confirm — returns "" against a non-empty baseline.
		getEditorMarkdownForSave.mockReturnValueOnce("");

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.error).toHaveBeenCalledTimes(1);
		// No phase-2 RPC was issued.
		expect(mockUpdateWithContext).toHaveBeenCalledTimes(1);
		// Review remains recoverable.
		expect(result.current.showingDiff).toBe(true);
	});
});

describe("useUpdateDocumentWithContext — the confirm names the preview's base (Fizzy #2946)", () => {
	const PREVIEW = {
		hasRelevantContext: true,
		summary: "",
		needsHumanResolution: false,
		proposedContent: "# Doc — with a real added sentence.",
		documentVersion: 4,
	};

	it("sends the base read when the preview started, not one read at confirm", async () => {
		let current = { version: 4, contentHash: "hash-at-preview" };
		const { result, getEditorMarkdownForSave } = setup(() => current);
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
		mockUpdateWithContext.mockResolvedValueOnce(PREVIEW);
		await act(async () => {
			await result.current.start();
		});
		// Someone saved while the review was open: the confirm must still
		// name the body its preview was drafted from.
		current = { version: 5, contentHash: "hash-of-a-later-save" };

		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: true,
			summary: "",
			documentVersion: 5,
		});
		await act(async () => {
			await result.current.confirm();
		});

		expect(mockUpdateWithContext).toHaveBeenLastCalledWith(
			expect.objectContaining({
				preview: false,
				expectedVersion: 4,
				expectedContentHash: "hash-at-preview",
			}),
		);
	});

	it("sends no base when saves name none", async () => {
		const { result, getEditorMarkdownForSave } = setup(() => undefined);
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
		mockUpdateWithContext.mockResolvedValueOnce(PREVIEW);
		await act(async () => {
			await result.current.start();
		});
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: true,
			summary: "",
			documentVersion: 5,
		});
		await act(async () => {
			await result.current.confirm();
		});

		const confirmInput = mockUpdateWithContext.mock.calls[1][0];
		expect(confirmInput).not.toHaveProperty("expectedVersion");
		expect(confirmInput).not.toHaveProperty("expectedContentHash");
	});

	it("does not start a preview while the room has no base yet", async () => {
		const { result, setEditable, getEditorMarkdownForSave } = setup(
			() => "unavailable",
		);
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc");

		await act(async () => {
			await result.current.start();
		});

		expect(mockUpdateWithContext).not.toHaveBeenCalled();
		expect(mockToast.info).toHaveBeenCalledTimes(1);
		expect(setEditable).not.toHaveBeenCalled();
		expect(result.current.isActive).toBe(false);
	});
});

describe("useUpdateDocumentWithContext — refusals in the reader's words (Fizzy #2946)", () => {
	const PREVIEW = {
		hasRelevantContext: true,
		summary: "",
		needsHumanResolution: false,
		proposedContent: "# Doc — with a real added sentence.",
		documentVersion: 4,
	};

	it.each([
		[
			"a run writing the document",
			refusal(
				"CONFLICT",
				"DOCUMENT_GENERATION_IN_PROGRESS",
				"A generation run is writing this document; try again when it finishes.",
			),
			REFUSAL_COPY.runLive,
		],
		[
			"a save since the preview",
			refusal(
				"CONFLICT",
				undefined,
				"The document changed while the update was being applied. Try again.",
			),
			REFUSAL_COPY.changedMeanwhile,
		],
		[
			"a page too old to name its base",
			refusal(
				"PRECONDITION_FAILED",
				"DOCUMENT_SAVE_BASE_REQUIRED",
				"This editor is out of date, so your changes were not saved. Reload the page to keep editing.",
			),
			REFUSAL_COPY.baseRequired,
		],
		[
			"anything else",
			refusal("INTERNAL_SERVER_ERROR", undefined, "socket hang up"),
			REFUSAL_COPY.failed,
		],
	])(
		"tells a confirm refused by %s, and keeps the review open",
		async (_label, error, expected) => {
			const { result, getEditorMarkdownForSave } = setup(() => ({
				version: 4,
				contentHash: "hash-at-preview",
			}));
			getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
			mockUpdateWithContext.mockResolvedValueOnce(PREVIEW);
			await act(async () => {
				await result.current.start();
			});
			getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
			mockUpdateWithContext.mockRejectedValueOnce(error);

			await act(async () => {
				await result.current.confirm();
			});

			expect(mockToast.error).toHaveBeenCalledTimes(1);
			expect(mockToast.error).toHaveBeenCalledWith(expected);
			expect(mockToast.error).not.toHaveBeenCalledWith(error.message);
			expect(result.current.showingDiff).toBe(true);
			expect(result.current.isApplying).toBe(false);
		},
	);

	it.each([
		[
			"no AI provider for the organization",
			refusal(
				"INTERNAL_SERVER_ERROR",
				"AI_PROVIDER_NOT_CONFIGURED",
				"No AI provider is configured for this organization. Add one in AI settings, then try again.",
			),
			COPY.aiProviderMissing,
		],
		[
			"a document too large for the model's output",
			refusal(
				"INTERNAL_SERVER_ERROR",
				"CONTEXT_UPDATE_TRUNCATED",
				"The document is too large for the configured AI model's output limit — the update was truncated before completion. Try a model with a larger output limit or split the document.",
			),
			COPY.documentTooLarge,
		],
		[
			"a model call that failed",
			refusal(
				"INTERNAL_SERVER_ERROR",
				"CONTEXT_UPDATE_FAILED",
				"The AI could not complete the update — the model call failed. This is not an AI-settings problem; try again, and if it keeps happening check the provider's status.",
			),
			COPY.modelCallFailed,
		],
	])(
		"tells a preview refused by %s with what resolves it, in the reader's words",
		async (_label, error, expected) => {
			const { result, getEditorMarkdownForSave } = setup();
			getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
			mockUpdateWithContext.mockRejectedValueOnce(error);

			await act(async () => {
				await result.current.start();
			});

			expect(mockToast.error).toHaveBeenCalledTimes(1);
			expect(mockToast.error).toHaveBeenCalledWith(expected);
			expect(mockToast.error).not.toHaveBeenCalledWith(error.message);
			expect(result.current.isActive).toBe(false);
		},
	);

	it.each([
		["no code", undefined],
		["a code it does not know", "SOME_FUTURE_CODE"],
	])(
		"tells a preview that failed with %s as a failure to draft, not the server's words",
		async (_label, dataCode) => {
			const { result, setEditable, getEditorMarkdownForSave } = setup();
			getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
			const error = refusal(
				"INTERNAL_SERVER_ERROR",
				dataCode,
				"Provider timeout after 30000ms",
			);
			mockUpdateWithContext.mockRejectedValueOnce(error);

			await act(async () => {
				await result.current.start();
			});

			expect(mockToast.error).toHaveBeenCalledWith(COPY.previewFailed);
			expect(mockToast.error).not.toHaveBeenCalledWith(error.message);
			expect(result.current.isActive).toBe(false);
			expect(setEditable).toHaveBeenLastCalledWith(true);
		},
	);

	it("says its own messages in the reader's locale", async () => {
		const { result, getEditorMarkdownForSave } = setup(() => "unavailable");
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
		await act(async () => {
			await result.current.start();
		});
		expect(mockToast.info).toHaveBeenCalledWith(COPY.syncing);
	});

	it("names the loading stage in the reader's locale", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc");
		mockUpdateWithContext.mockReturnValueOnce(new Promise(() => {}));

		await act(async () => {
			void result.current.start();
		});

		expect(result.current.isLoading).toBe(true);
		expect(result.current.loadingStage).toBe(COPY.loadingStage.scanning);
	});
});
