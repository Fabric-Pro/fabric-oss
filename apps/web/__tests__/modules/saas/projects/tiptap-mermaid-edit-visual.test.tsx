/**
 * Edit with instructions on a client-document Proposal's diagram (Fizzy
 * #2946): the panel saves the editor, asks the server for a fact-checked
 * candidate, shows it below the current diagram, and applies it to that
 * node alone when the node still holds the source the request was made
 * from.
 *
 * The editor is the document editor's own extension set with the real node
 * view, menu and renderer; the translations are the real message files and
 * the oRPC client is stubbed.
 */

import {
	classifyVisualFences,
	diagramSectionFingerprint,
	readVisualMarker,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiagramHarness,
	FLOWCHART_BODY,
	fence,
	MARKER,
	VISUAL_ID,
} from "./tiptap-mermaid-visual-harness";

vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal<typeof import("beautiful-mermaid")>();
	return {
		...actual,
		renderMermaidSVG: (
			code: string,
			options: Parameters<typeof actual.renderMermaidSVG>[1],
		) => {
			if (code.includes("BROKEN")) {
				throw new Error("Parse error on line 2");
			}
			return actual.renderMermaidSVG(code, options);
		},
	};
});

vi.mock("mermaid", () => {
	const api = {
		initialize: () => {},
		mermaidAPI: { getSiteConfig: () => ({}) },
		render: async () => {
			throw new Error("Parse error on line 2");
		},
	};
	return { default: api };
});

const intl = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const en = (await import("@repo/i18n/translations/en.json")).default;
	const de = (await import("@repo/i18n/translations/de.json")).default;
	return {
		useTranslations: (namespace: string) =>
			actual.createTranslator({
				locale: intl.locale,
				messages: (intl.locale === "de" ? de : en) as never,
				namespace: namespace as never,
				onError: () => {},
			}),
		useLocale: () => intl.locale,
	};
});

const rpc = vi.hoisted(() => ({
	listVisualSpecs: vi.fn(),
	editVisual: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				listVisualSpecs: rpc.listVisualSpecs,
				editVisual: rpc.editVisual,
			},
		},
	},
}));

const TARGET = fence(FLOWCHART_BODY);
const TARGET_HASH = visualSourceHash(FLOWCHART_BODY.join("\n"));
// A hand-edited diagram before the target, so the target is the second.
const HAND_EDITED = fence(["flowchart TD", '  a["Kick-off"] --> b["Review"]']);
const DOCUMENT = [
	"## Delivery",
	"",
	"We start with **discovery** in Q1 2026.",
	"",
	HAND_EDITED,
	"",
	"Then we launch.",
	"",
	TARGET,
	"",
	"- Next steps follow.",
].join("\n");

const CANDIDATE_BODY = [
	MARKER,
	"flowchart TB",
	'  t0["Discovery"]',
	'  t1["Launch"]',
	"  t0 --> t1",
	"  class t0 surface",
	"  class t1 surface",
].join("\n");

/** The target's section as the server fingerprints the saved Main. */
const SECTION_FINGERPRINT = diagramSectionFingerprint(DOCUMENT, 1) ?? "";

function candidate(body = CANDIDATE_BODY) {
	return {
		status: "CANDIDATE" as const,
		fence: body,
		visualId: readVisualMarker(body).visualId ?? VISUAL_ID,
		kind: "flow",
		sectionFingerprint: SECTION_FINGERPRINT,
	};
}

/** Replace `from` with `to` in the editor's text, as a person typing would. */
function editProse(editor: Editor, from: string, to: string) {
	act(() => {
		const { state, view } = editor;
		let range: { from: number; to: number } | null = null;
		state.doc.descendants((node, pos) => {
			if (range || !node.isText) {
				return !range;
			}
			const at = node.text?.indexOf(from) ?? -1;
			if (at !== -1) {
				range = { from: pos + at, to: pos + at + from.length };
			}
			return false;
		});
		if (!range) {
			throw new Error("no such text");
		}
		const { from: start, to: end } = range;
		view.dispatch(state.tr.insertText(to, start, end));
	});
}

async function renderEditor(
	options: {
		markdown?: string;
		isMember?: boolean;
		flushSave?: () => Promise<boolean>;
	} = {},
) {
	let editor: Editor | null = null;
	const flushSave = options.flushSave ?? vi.fn(async () => true);
	const utils = render(
		<DiagramHarness
			markdown={options.markdown ?? DOCUMENT}
			visual={{ isMember: options.isMember ?? true, flushSave }}
			onEditor={(created) => {
				editor = created;
			}}
		/>,
	);
	await waitFor(() => {
		if (
			utils.container.querySelectorAll(".mermaid-diagram-area svg")
				.length < 1
		) {
			throw new Error("no diagram yet");
		}
	});
	const getEditor = () => {
		if (!editor) {
			throw new Error("no editor");
		}
		return editor as Editor;
	};
	return { ...utils, editor: getEditor, flushSave };
}

/** The trigger of the diagram at `index` among the page's diagrams. */
function triggers() {
	return screen.getAllByRole("button", { name: "Diagram actions" });
}

async function openPanel(user: ReturnType<typeof userEvent.setup>, index = 1) {
	const trigger = triggers()[index];
	act(() => trigger.focus());
	await user.keyboard("{Enter}");
	await user.click(
		await screen.findByRole("menuitem", { name: "Edit with instructions" }),
	);
	const field = await screen.findByRole("textbox", {
		name: "What should change in this diagram?",
	});
	return { trigger, field };
}

/** The target diagram's polite live region. */
function liveRegion(container: HTMLElement) {
	return container
		.querySelectorAll(".mermaid-visual")[1]
		?.querySelector("output[aria-live='polite']");
}

function generateButton() {
	return screen.getByRole("button", { name: /^(Generate|Try again|Retry)$/ });
}

beforeEach(() => {
	intl.locale = "en";
	rpc.listVisualSpecs.mockReset();
	rpc.editVisual.mockReset();
	rpc.listVisualSpecs.mockResolvedValue({
		specs: [
			{
				visualId: VISUAL_ID,
				sourceHash: TARGET_HASH,
				kind: "flow",
				origin: "STEP",
			},
		],
	});
});

describe("the instruction field", () => {
	it("keeps Generate disabled while it is empty or over 500 characters, counting from 450", async () => {
		const user = userEvent.setup();
		await renderEditor();
		const { field } = await openPanel(user);

		expect(generateButton()).toBeDisabled();
		await user.type(field, "   ");
		expect(generateButton()).toBeDisabled();

		await user.clear(field);
		await user.click(field);
		await user.paste("a".repeat(449));
		expect(screen.queryByText(/\/ 500$/)).not.toBeInTheDocument();
		expect(generateButton()).toBeEnabled();

		await user.paste("a");
		expect(screen.getByText("450 / 500")).toBeInTheDocument();

		await user.paste("a".repeat(51));
		expect(screen.getByText("501 / 500")).toBeInTheDocument();
		expect(
			screen.getByText("Use at most 500 characters."),
		).toBeInTheDocument();
		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(generateButton()).toBeDisabled();
		expect(rpc.editVisual).not.toHaveBeenCalled();
	});
});

describe("generating a candidate", () => {
	it("saves the editor first, asks for this diagram by id, position and source hash, and shows the candidate below it labelled Proposed", async () => {
		const user = userEvent.setup();
		const order: string[] = [];
		const flushSave = vi.fn(async () => {
			order.push("save");
			return true;
		});
		rpc.editVisual.mockImplementation(async () => {
			order.push("edit");
			return candidate();
		});
		const { container } = await renderEditor({ flushSave });
		const { field } = await openPanel(user);

		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());

		expect(await screen.findByText("Proposed")).toBeInTheDocument();
		expect(order).toEqual(["save", "edit"]);
		expect(rpc.editVisual).toHaveBeenCalledWith(
			{
				projectId: "project-1",
				documentId: "document-1",
				visualId: VISUAL_ID,
				fenceOrdinal: 1,
				fenceSourceHash: TARGET_HASH,
				instruction: "Lay it out top to bottom",
			},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const status = liveRegion(container);
		expect(status?.textContent).toBe(
			"A proposed diagram is ready. Review it below the current one, then apply or discard it.",
		);
		// Below the current diagram: the current one comes first.
		const target = container.querySelectorAll(".mermaid-visual")[1];
		const areas = target?.querySelectorAll(".mermaid-diagram-area");
		expect(areas).toHaveLength(2);
		expect(areas?.[1]?.classList.contains("mermaid-candidate-area")).toBe(
			true,
		);
		expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
	});

	it("does not ask when the save is refused, and says the diagram changed", async () => {
		const user = userEvent.setup();
		await renderEditor({ flushSave: vi.fn(async () => false) });
		const { field } = await openPanel(user);

		await user.type(field, "Shorten the labels");
		await user.click(generateButton());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The diagram changed. Try again on the current version.",
		);
		expect(rpc.editVisual).not.toHaveBeenCalled();
		expect(field).toHaveValue("Shorten the labels");
	});

	it("Cancel aborts the request and drops its late response, keeping the instruction", async () => {
		const user = userEvent.setup();
		let respond: (value: unknown) => void = () => {};
		let signal: AbortSignal | undefined;
		rpc.editVisual.mockImplementation(
			(_input: unknown, options: { signal: AbortSignal }) => {
				signal = options.signal;
				return new Promise((resolve) => {
					respond = resolve;
				});
			},
		);
		const { container } = await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Shorten the labels");
		await user.click(generateButton());
		await waitFor(() => expect(rpc.editVisual).toHaveBeenCalled());
		expect(liveRegion(container)?.textContent).toBe(
			"Generating a proposed diagram…",
		);

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			respond(candidate());
		});

		expect(screen.queryByText("Proposed")).not.toBeInTheDocument();
		expect(
			screen.getByRole("textbox", {
				name: "What should change in this diagram?",
			}),
		).toHaveValue("Shorten the labels");
	});

	it.each([
		[
			{ status: "STALE" },
			"The diagram changed. Try again on the current version.",
			"Try again",
		],
		[
			{ status: "FACT_CHECK_REFUSED", violations: ["presence:date"] },
			"The change would add facts the section does not state.",
			"Try again",
		],
		[
			{ status: "UNSUPPORTED_DIAGRAM" },
			"Only flowchart diagrams can be edited this way.",
			"Generate",
		],
		[
			{ status: "RATE_LIMITED" },
			"Too many AI requests right now. Wait a moment, then try again.",
			"Try again",
		],
	])(
		"answers %j with its own message, the instruction kept",
		async (answer, message, again) => {
			const user = userEvent.setup();
			rpc.editVisual.mockResolvedValue(answer);
			const { editor } = await renderEditor();
			const before = getEditorMarkdownForSave(editor());
			const { field } = await openPanel(user);
			await user.type(field, "Add the go-live date");
			await user.click(generateButton());

			expect(await screen.findByRole("alert")).toHaveTextContent(message);
			expect(field).toHaveValue("Add the go-live date");
			expect(screen.getByRole("button", { name: again })).toBeEnabled();
			expect(getEditorMarkdownForSave(editor())).toBe(before);
		},
	);

	it("Try again after a refusal sends the instruction against the current source", async () => {
		const user = userEvent.setup();
		rpc.editVisual
			.mockResolvedValueOnce({ status: "STALE" })
			.mockResolvedValueOnce(candidate());
		await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Shorten the labels");
		await user.click(generateButton());
		await screen.findByRole("alert");

		await user.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByText("Proposed")).toBeInTheDocument();
		expect(rpc.editVisual).toHaveBeenCalledTimes(2);
		expect(rpc.editVisual.mock.calls[1]?.[0]).toMatchObject({
			fenceSourceHash: TARGET_HASH,
			instruction: "Shorten the labels",
		});
	});

	it.each([
		[true, "Set up an AI provider for your organization"],
		[false, "AI editing is not available for this project"],
	])(
		"a missing AI provider reads, for a member %s, “%s”",
		async (isMember, message) => {
			const user = userEvent.setup();
			rpc.editVisual.mockResolvedValue({
				status: "AI_PROVIDER_NOT_CONFIGURED",
			});
			await renderEditor({ isMember });
			const { field } = await openPanel(user);
			await user.type(field, "Shorten the labels");
			await user.click(generateButton());

			expect(await screen.findByRole("alert")).toHaveTextContent(message);
		},
	);

	it("a forbidden request says so, and any other failure offers Retry", async () => {
		const user = userEvent.setup();
		rpc.editVisual
			.mockRejectedValueOnce(
				Object.assign(new Error("no"), { code: "FORBIDDEN" }),
			)
			.mockRejectedValueOnce(new Error("network down"));
		await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Shorten the labels");

		await user.click(generateButton());
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"You do not have permission to edit this diagram.",
		);

		await user.click(generateButton());
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"The proposed diagram could not be generated.",
			),
		);
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
	});

	it("a candidate that cannot be drawn cannot be applied", async () => {
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(
			candidate(`${MARKER}\nflowchart LR\n  a["BROKEN`),
		);
		await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Shorten the labels");
		await user.click(generateButton());

		await screen.findByText("Proposed");
		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
		expect(
			screen.getAllByText(
				"The proposed diagram could not be drawn, so it cannot be applied.",
			).length,
		).toBeGreaterThan(0);
	});
});

describe("applying a candidate", () => {
	it("replaces only this diagram: the saved Markdown outside its fence is byte-identical, and it then reads as updated with instructions", async () => {
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(candidate());
		const { editor } = await renderEditor();
		const before = getEditorMarkdownForSave(editor()) ?? "";
		expect(before).toContain(TARGET);
		// The editor's save fingerprints its section as the stored Main does.
		expect(diagramSectionFingerprint(before, 1)).toBe(SECTION_FINGERPRINT);
		const { trigger, field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");
		const candidateHash = visualSourceHash(CANDIDATE_BODY);
		rpc.listVisualSpecs.mockResolvedValue({
			specs: [
				{
					visualId: VISUAL_ID,
					sourceHash: TARGET_HASH,
					kind: "flow",
					origin: "STEP",
				},
				{
					visualId: VISUAL_ID,
					sourceHash: candidateHash,
					kind: "flow",
					origin: "INSTRUCTION",
				},
			],
		});

		await user.click(screen.getByRole("button", { name: "Apply" }));

		const after = getEditorMarkdownForSave(editor()) ?? "";
		const appliedFence = fence(CANDIDATE_BODY.split("\n"));
		expect(after).toBe(before.replace(TARGET, appliedFence));
		const [head, tail] = before.split(TARGET);
		expect(after.startsWith(head ?? "")).toBe(true);
		expect(after.endsWith(tail ?? "")).toBe(true);
		expect(after).toContain(HAND_EDITED);

		const rows = (await rpc.listVisualSpecs.mock.results.at(-1)?.value)
			?.specs;
		expect(classifyVisualFences(after, rows)[1]).toMatchObject({
			state: "generated",
			origin: "INSTRUCTION",
			visualId: VISUAL_ID,
		});
		expect(
			await screen.findByText("Updated with instructions"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", {
				name: "What should change in this diagram?",
			}),
		).not.toBeInTheDocument();
		await waitFor(() => expect(triggers()[1] ?? trigger).toHaveFocus());
	});

	it("keeps the diagram's caption, whatever caption line the candidate carries", async () => {
		const user = userEvent.setup();
		const captioned = fence([
			MARKER,
			"%% caption: Delivery plan",
			...FLOWCHART_BODY.slice(1),
		]);
		rpc.editVisual.mockResolvedValue(
			candidate(
				CANDIDATE_BODY.replace(
					MARKER,
					`${MARKER}\n%% caption: Invented`,
				),
			),
		);
		const { editor } = await renderEditor({
			markdown: DOCUMENT.replace(TARGET, captioned),
		});
		const before = getEditorMarkdownForSave(editor()) ?? "";
		expect(before).toContain(captioned);
		const { field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");

		await user.click(screen.getByRole("button", { name: "Apply" }));

		const expected = fence([
			MARKER,
			"%% caption: Delivery plan",
			...CANDIDATE_BODY.split("\n").slice(1),
		]);
		expect(getEditorMarkdownForSave(editor())).toBe(
			before.replace(captioned, expected),
		);
	});

	it("says the diagram changed, and leaves the document alone, when the diagram was edited after the candidate came", async () => {
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(candidate());
		const { editor } = await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");

		// Someone edits the target diagram's source meanwhile.
		act(() => {
			const { state, view } = editor();
			let pos = -1;
			state.doc.descendants((node, at) => {
				if (node.type.name === "mermaidBlock") {
					pos = at;
				}
			});
			const current = state.doc.nodeAt(pos);
			if (!current) {
				throw new Error("no target");
			}
			const changed = current.type.create(current.attrs, [
				state.schema.text(`${current.textContent}\n  t1 --> t2`),
			]);
			view.dispatch(
				state.tr.replaceWith(pos, pos + current.nodeSize, changed),
			);
		});
		const edited = getEditorMarkdownForSave(editor());

		await user.click(screen.getByRole("button", { name: "Apply" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The diagram changed. Try again on the current version.",
		);
		expect(getEditorMarkdownForSave(editor())).toBe(edited);
	});

	it.each([
		["the sentence before it", "in Q1 2026", "in Q2 2026"],
		["the list after it", "Next steps follow.", "Next steps vary."],
	])(
		"says the diagram changed, and leaves the document alone, when %s was edited after the candidate came",
		async (_label, from, to) => {
			const user = userEvent.setup();
			rpc.editVisual.mockResolvedValue(candidate());
			const { editor } = await renderEditor();
			const { field } = await openPanel(user);
			await user.type(field, "Lay it out top to bottom");
			await user.click(generateButton());
			await screen.findByText("Proposed");

			editProse(editor(), from, to);
			const edited = getEditorMarkdownForSave(editor());
			expect(edited).toContain(to);

			await user.click(screen.getByRole("button", { name: "Apply" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"The diagram changed. Try again on the current version.",
			);
			expect(getEditorMarkdownForSave(editor())).toBe(edited);
		},
	);

	it("says the diagram changed, and leaves the document alone, when the candidate was made under another diagram's id", async () => {
		const user = userEvent.setup();
		// A same-source twin in this section, answered for in its place.
		const otherId = "q1w2e3r4t5y6u7i8";
		const body = [
			`%% fabric-visual: ${otherId}`,
			...CANDIDATE_BODY.split("\n").slice(1),
		].join("\n");
		rpc.editVisual.mockResolvedValue(candidate(body));
		const { editor } = await renderEditor();
		const { field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");
		const before = getEditorMarkdownForSave(editor());

		await user.click(screen.getByRole("button", { name: "Apply" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The diagram changed. Try again on the current version.",
		);
		expect(getEditorMarkdownForSave(editor())).toBe(before);
		expect(before).not.toContain(otherId);
	});

	it("applies when text outside the diagram's section changed after the candidate came", async () => {
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(candidate());
		const markdown = `${DOCUMENT}\n\n## Pricing\n\nThe fee is fixed.`;
		const { editor } = await renderEditor({ markdown });
		const { field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");

		editProse(editor(), "The fee is fixed.", "The fee is monthly.");
		await user.click(screen.getByRole("button", { name: "Apply" }));

		const saved = getEditorMarkdownForSave(editor()) ?? "";
		expect(saved).toContain(fence(CANDIDATE_BODY.split("\n")));
		expect(saved).toContain("The fee is monthly.");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("gives a diagram without a marker the candidate's fresh marker, at its own position", async () => {
		const user = userEvent.setup();
		const unmarked = FLOWCHART_BODY.slice(1);
		const freshId = "z9y8x7w6v5u4t3s2";
		const body = [
			`%% fabric-visual: ${freshId}`,
			...CANDIDATE_BODY.split("\n").slice(1),
		].join("\n");
		rpc.editVisual.mockResolvedValue(candidate(body));
		const markdown = DOCUMENT.replace(TARGET, fence(unmarked));
		const { editor } = await renderEditor({ markdown });
		const { field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");

		expect(rpc.editVisual.mock.calls[0]?.[0]).toEqual({
			projectId: "project-1",
			documentId: "document-1",
			fenceOrdinal: 1,
			fenceSourceHash: visualSourceHash(unmarked.join("\n")),
			instruction: "Lay it out top to bottom",
		});
		await user.click(screen.getByRole("button", { name: "Apply" }));

		const saved = getEditorMarkdownForSave(editor()) ?? "";
		expect(
			classifyVisualFences(saved, [
				{
					visualId: freshId,
					sourceHash: visualSourceHash(body),
					kind: "flow",
					origin: "INSTRUCTION",
				},
			])[1],
		).toMatchObject({ state: "generated", origin: "INSTRUCTION" });
	});

	it("Discard closes the panel, changes nothing, and returns focus to the trigger", async () => {
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(candidate());
		const { editor, container } = await renderEditor();
		const before = getEditorMarkdownForSave(editor());
		const { trigger, field } = await openPanel(user);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");

		await user.click(screen.getByRole("button", { name: "Discard" }));

		expect(screen.queryByText("Proposed")).not.toBeInTheDocument();
		expect(getEditorMarkdownForSave(editor())).toBe(before);
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(liveRegion(container)?.textContent).toBe(
			"The proposed diagram was discarded.",
		);
	});
});

describe("a diagram inserted above", () => {
	function diagramAt(container: HTMLElement, index: number) {
		return container.querySelectorAll(".mermaid-visual")[index];
	}

	async function insertAtTop(editor: Editor, lines: string[]) {
		act(() => {
			editor
				.chain()
				.insertContentAt(0, {
					type: "mermaidBlock",
					content: [{ type: "text", text: lines.join("\n") }],
				})
				.run();
		});
		await waitFor(() =>
			expect(
				document.querySelectorAll(".mermaid-diagram-area svg"),
			).toHaveLength(3),
		);
	}

	it("leaves the generated diagram below its origin and asks for it at its new position", async () => {
		const user = userEvent.setup();
		const { container, editor } = await renderEditor();
		await waitFor(() =>
			expect(diagramAt(container, 1)).toHaveTextContent(
				"Added automatically",
			),
		);

		await insertAtTop(editor(), [
			"flowchart LR",
			'  x["Intro"] --> y["Plan"]',
		]);

		expect(diagramAt(container, 0)).not.toHaveTextContent(
			"Added automatically",
		);
		expect(diagramAt(container, 2)).toHaveTextContent(
			"Added automatically",
		);

		rpc.editVisual.mockResolvedValue(candidate());
		const { field } = await openPanel(user, 2);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());

		expect(await screen.findByText("Proposed")).toBeInTheDocument();
		expect(rpc.editVisual).toHaveBeenCalledWith(
			expect.objectContaining({
				visualId: VISUAL_ID,
				fenceOrdinal: 2,
				fenceSourceHash: TARGET_HASH,
			}),
			expect.anything(),
		);
	});

	it("reclassifies the diagram below when a copy of it is pasted above: the first occurrence keeps the origin", async () => {
		const { container, editor } = await renderEditor();
		await waitFor(() =>
			expect(diagramAt(container, 1)).toHaveTextContent(
				"Added automatically",
			),
		);

		await insertAtTop(editor(), FLOWCHART_BODY);

		await waitFor(() =>
			expect(diagramAt(container, 2)).not.toHaveTextContent(
				"Added automatically",
			),
		);
		expect(diagramAt(container, 0)).toHaveTextContent(
			"Added automatically",
		);

		// An edit of the second copy names no id: the id is the first one's.
		const user = userEvent.setup();
		rpc.editVisual.mockResolvedValue(candidate());
		const { field } = await openPanel(user, 2);
		await user.type(field, "Lay it out top to bottom");
		await user.click(generateButton());
		await screen.findByText("Proposed");
		expect(rpc.editVisual.mock.calls[0]?.[0]).toEqual({
			projectId: "project-1",
			documentId: "document-1",
			fenceOrdinal: 2,
			fenceSourceHash: TARGET_HASH,
			instruction: "Lay it out top to bottom",
		});
	});
});
