import { generateHTML, generateJSON } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionExtension } from "../mention-extension";

// ---------------------------------------------------------------------------
// Helpers for Task 7 & 8 tests
// ---------------------------------------------------------------------------

/** Pull the `suggestion.render` function out of a built extension's options. */
function getSuggestionRender(ext: typeof MentionExtension) {
	return (
		ext.options as unknown as {
			suggestion: {
				render: () => Record<string, (props: unknown) => unknown>;
			};
		}
	).suggestion.render;
}

/** Create a minimal fake editor with a real DOM element. */
function makeEditor() {
	const dom = document.createElement("div");
	return { view: { dom } } as unknown as import("@tiptap/core").Editor;
}

/** Stub the tippy and ReactRenderer side-effects so render() can be called
 *  in a JSDOM environment without throwing. */
function withStubbedDeps(fn: () => void) {
	vi.mock("tippy.js", () => ({
		default: () => [
			{
				hide: vi.fn(),
				destroy: vi.fn(),
				setProps: vi.fn(),
			},
		],
	}));
	vi.mock("@tiptap/react", async (importOriginal) => {
		const original = await importOriginal<typeof import("@tiptap/react")>();
		return {
			...original,
			ReactRenderer: class {
				element = document.createElement("div");
				ref = { onKeyDown: vi.fn() };
				updateProps = vi.fn();
				destroy = vi.fn();
			},
			ReactNodeViewRenderer: vi.fn(() => vi.fn()),
		};
	});
	try {
		fn();
	} finally {
		vi.restoreAllMocks();
	}
}

const exts = [StarterKit, MentionExtension];

describe("MentionExtension", () => {
	it("serializes a mention node to a span with data-type, data-id, data-mention-id", () => {
		const json = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "mention",
							attrs: {
								id: "u_1",
								label: "Alice",
								mentionId: "m_xyz",
							},
						},
					],
				},
			],
		};

		const html = generateHTML(json, exts);
		expect(html).toContain('data-type="mention"');
		expect(html).toContain('data-id="u_1"');
		expect(html).toContain('data-mention-id="m_xyz"');
		expect(html).toContain("@Alice");
	});

	it("round-trips HTML → JSON → HTML", () => {
		const html =
			'<p><span data-type="mention" data-id="u_1" data-label="Alice" data-mention-id="m_xyz">@Alice</span></p>';
		const json = generateJSON(html, exts);
		const back = generateHTML(json, exts);
		expect(back).toContain('data-id="u_1"');
		expect(back).toContain('data-mention-id="m_xyz"');
		// `data-label` must survive round-trip so the rendered DOM keeps
		// the human-readable name even if the popover/agent who wrote it
		// is offline (and so editor-side renders don't drop the label).
		expect(back).toContain('data-label="Alice"');
	});
});

describe("buildMentionExtension", () => {
	const searchMentionablesMock = vi.fn();

	beforeEach(() => {
		vi.resetModules();
		searchMentionablesMock.mockReset();
		searchMentionablesMock.mockResolvedValue({ members: [] });
		vi.doMock("@shared/lib/orpc-client", () => ({
			orpcClient: {
				projects: {
					documents: {
						searchMentionables: searchMentionablesMock,
					},
				},
			},
		}));
	});

	afterEach(() => {
		vi.doUnmock("@shared/lib/orpc-client");
	});

	it("forwards the resolved projectId + documentId into searchMentionables", async () => {
		const { buildMentionExtension: build } = await import(
			"../mention-extension"
		);

		const extension = build({
			getProjectId: () => "proj_1",
			getDocumentId: () => "doc_1",
		});
		const items = (
			extension.options as unknown as {
				suggestion: {
					items: (args: { query: string }) => Promise<unknown>;
				};
			}
		).suggestion.items;

		await items({ query: "ali" });

		expect(searchMentionablesMock).toHaveBeenCalledTimes(1);
		expect(searchMentionablesMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			documentId: "doc_1",
			query: "ali",
		});
	});

	it("re-evaluates getProjectId/getDocumentId on each query", async () => {
		const { buildMentionExtension: build } = await import(
			"../mention-extension"
		);

		let activeProjectId: string | null = "proj_1";
		let activeDocumentId: string | null = "doc_1";
		const extension = build({
			getProjectId: () => activeProjectId,
			getDocumentId: () => activeDocumentId,
		});
		const items = (
			extension.options as unknown as {
				suggestion: {
					items: (args: { query: string }) => Promise<unknown>;
				};
			}
		).suggestion.items;

		await items({ query: "" });
		activeProjectId = "proj_2";
		activeDocumentId = "doc_2";
		await items({ query: "" });

		const calls = searchMentionablesMock.mock.calls.map(
			(call: unknown[]) =>
				call[0] as { projectId: string; documentId: string },
		);
		expect(calls.map((c) => c.projectId)).toEqual(["proj_1", "proj_2"]);
		expect(calls.map((c) => c.documentId)).toEqual(["doc_1", "doc_2"]);
	});

	it("yields no items and skips the network call when projectId or documentId is null", async () => {
		const { buildMentionExtension: build } = await import(
			"../mention-extension"
		);

		const extension = build({
			getProjectId: () => null,
			getDocumentId: () => null,
		});
		const items = (
			extension.options as unknown as {
				suggestion: {
					items: (args: { query: string }) => Promise<Array<unknown>>;
				};
			}
		).suggestion.items;

		const result = await items({ query: "anything" });

		expect(result).toEqual([]);
		expect(searchMentionablesMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Task 7 — ReactNodeViewRenderer wiring
// ---------------------------------------------------------------------------

describe("MentionExtension node view", () => {
	it("declares addNodeView so TipTap uses a React node view renderer", () => {
		// When the extension is built, the Node instance should expose an
		// `addNodeView` method that returns a callable renderer.
		// TipTap's Node.create() stores extensions-with-options via
		// `config` internally; after `.configure()` the options are merged
		// and the method is accessible directly on the returned extension.
		const ext = MentionExtension as unknown as {
			type: string;
			config: Record<string, unknown>;
		};
		// The extension type must be "node" (mention is a node extension).
		expect(ext.type).toBe("node");
		// The extension config must carry an addNodeView factory function.
		expect(typeof (ext.config as Record<string, unknown>).addNodeView).toBe(
			"function",
		);
	});
});

// ---------------------------------------------------------------------------
// Task 8 — ARIA combobox lifecycle
// ---------------------------------------------------------------------------

describe("mention suggestion ARIA lifecycle", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("tippy.js", () => ({
			default: () => [
				{ hide: vi.fn(), destroy: vi.fn(), setProps: vi.fn() },
			],
		}));
		vi.doMock("@tiptap/react", async (importOriginal) => {
			const original =
				await importOriginal<typeof import("@tiptap/react")>();
			return {
				...original,
				ReactRenderer: class {
					element = document.createElement("div");
					ref = { onKeyDown: vi.fn() };
					updateProps = vi.fn();
					destroy = vi.fn();
				},
				ReactNodeViewRenderer: vi.fn(() => vi.fn()),
			};
		});
	});

	afterEach(() => {
		vi.doUnmock("tippy.js");
		vi.doUnmock("@tiptap/react");
		vi.resetModules();
	});

	it("sets combobox ARIA attrs on editor.view.dom when the popover opens", async () => {
		const { MentionExtension: ext } = await import("../mention-extension");
		const render = getSuggestionRender(ext);
		const handlers = render();

		const editor = makeEditor();
		(handlers.onStart as (p: unknown) => void)({
			editor,
			range: {},
			query: "",
			// Pass a real clientRect fn so tippy initialises and popup is set.
			clientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
		});

		const dom = editor.view.dom;
		expect(dom.getAttribute("role")).toBe("combobox");
		expect(dom.getAttribute("aria-haspopup")).toBe("listbox");
		expect(dom.getAttribute("aria-expanded")).toBe("true");
		expect(dom.getAttribute("aria-controls")).toMatch(/^mention-listbox-/);
	});

	it("removes all combobox ARIA attrs from editor.view.dom when the popover closes", async () => {
		const { MentionExtension: ext } = await import("../mention-extension");
		const render = getSuggestionRender(ext);
		const handlers = render();

		const editor = makeEditor();
		const dom = editor.view.dom;

		// First open the popover so popup is initialised and ARIA attrs are set.
		(handlers.onStart as (p: unknown) => void)({
			editor,
			range: {},
			query: "",
			clientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
		});

		// Manually add aria-activedescendant (set by onKeyDown after navigation).
		dom.setAttribute("aria-activedescendant", "mention-listbox-xxx-opt-0");

		// Now close — all five attrs must be removed.
		(handlers.onExit as (p: unknown) => void)({ editor });

		for (const a of [
			"role",
			"aria-haspopup",
			"aria-expanded",
			"aria-controls",
			"aria-activedescendant",
		]) {
			expect(dom.getAttribute(a)).toBeNull();
		}
	});
});
