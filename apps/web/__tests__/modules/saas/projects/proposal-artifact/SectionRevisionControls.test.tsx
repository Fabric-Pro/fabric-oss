/**
 * Revise this section: the control beside each `##` heading of a
 * client-document Proposal's Main (Fizzy #2946).
 *
 * Pinned here, against a real editor:
 *   - one control per root `##` heading, named after its section, and none
 *     for the title or a `###`; none while revising is not possible or the
 *     editor is read-only;
 *   - the control opens a labelled box under its heading, focused, bounded
 *     to the shared maximum; Escape closes it and returns focus to the
 *     control, without asking for anything;
 *   - submitting, by the button or Ctrl+Enter, hands the section's key and
 *     the trimmed instruction to `onRequest` and closes the box; an empty
 *     instruction cannot be submitted; a request not taken keeps the box;
 *   - a heading whose section the editor's Markdown does not have is said,
 *     and nothing is asked for;
 *   - while the editor takes no input the open box stays, with what was
 *     typed, its submit disabled and the reason said; editable again, it
 *     submits; a box whose heading is gone closes and says so;
 *   - the key resolves by position, and by text when the counts differ.
 */

import { SECTION_REVISION_INSTRUCTION_MAX_CHARS } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			if (!translators.has(namespace)) {
				translators.set(
					namespace,
					createTranslator({
						locale: "en",
						messages,
						namespace: namespace as never,
						onError: () => {},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import {
	resolveHeadingSectionKey,
	SectionRevisionControls,
} from "@saas/projects/components/proposal-artifact/SectionRevisionControls";
import { toast } from "sonner";

const MARKDOWN = [
	"# Example proposal",
	"",
	"An opening paragraph for Example Org.",
	"",
	"## 1. Approach",
	"",
	"We start with a pilot.",
	"",
	"### Pilot scope",
	"",
	"Two teams.",
	"",
	"## 2. Pricing",
	"",
	"A fixed fee for the first phase.",
].join("\n");

const HTML = [
	"<h1>Example proposal</h1>",
	"<p>An opening paragraph for Example Org.</p>",
	"<h2>1. Approach</h2>",
	"<p>We start with a pilot.</p>",
	"<h3>Pilot scope</h3>",
	"<p>Two teams.</p>",
	"<h2>2. Pricing</h2>",
	"<p>A fixed fee for the first phase.</p>",
].join("");

function keyOf(markdown: string, heading: string): string {
	const section = buildSectionMap(markdown).sections.find(
		(entry) => entry.headingText === heading,
	);
	if (!section) {
		throw new Error(`no section ${heading}`);
	}
	return section.key;
}

function Harness({
	enabled = true,
	editable = true,
	markdown = MARKDOWN,
	onRequest,
	onEditor,
}: {
	enabled?: boolean;
	editable?: boolean;
	markdown?: string | null;
	onEditor?: (editor: Editor | null) => void;
	onRequest: (request: {
		sectionKey: string;
		instruction: string;
	}) => boolean;
}) {
	const editor = useEditor({
		extensions: [StarterKit],
		content: HTML,
		editable,
		immediatelyRender: true,
	});
	onEditor?.(editor);
	return (
		<div className="relative">
			<EditorContent editor={editor} />
			<SectionRevisionControls
				editor={editor}
				enabled={enabled}
				getMarkdown={() => markdown}
				onRequest={onRequest}
			/>
		</div>
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("Revise this section (Fizzy #2946)", () => {
	it("offers one control per root ## heading, named after its section", async () => {
		render(<Harness onRequest={vi.fn(() => true)} />);
		await waitFor(() => {
			expect(
				screen.getAllByRole("button", { name: /^Revise this section/ }),
			).toHaveLength(2);
		});
		expect(
			screen.getByRole("button", {
				name: "Revise this section: 1. Approach",
			}),
		).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.getByRole("button", {
				name: "Revise this section: 2. Pricing",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /Pilot scope|Example proposal/,
			}),
		).toBeNull();
	});

	it("offers nothing while revising is not possible, or in a read-only editor", async () => {
		const { unmount } = render(
			<Harness enabled={false} onRequest={vi.fn(() => true)} />,
		);
		// Measured once the editor exists; still nothing.
		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		});
		expect(
			screen.queryByRole("button", { name: /^Revise this section/ }),
		).toBeNull();
		unmount();

		render(<Harness editable={false} onRequest={vi.fn(() => true)} />);
		await act(async () => {
			await new Promise((resolve) => requestAnimationFrame(resolve));
		});
		expect(
			screen.queryByRole("button", { name: /^Revise this section/ }),
		).toBeNull();
	});

	it("opens a labelled, focused box under the heading; Escape closes it and returns focus without asking", async () => {
		const user = userEvent.setup();
		const onRequest = vi.fn(() => true);
		render(<Harness onRequest={onRequest} />);
		const trigger = await screen.findByRole("button", {
			name: "Revise this section: 2. Pricing",
		});

		// Reached and opened from the keyboard.
		trigger.focus();
		await user.keyboard("{Enter}");
		const box = screen.getByRole("form", { name: "Revise “2. Pricing”" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(trigger).toHaveAttribute("aria-controls", box.id);
		const field = screen.getByLabelText(
			"What should change in this section?",
		);
		expect(field).toHaveFocus();
		expect(field).toHaveAttribute(
			"maxLength",
			String(SECTION_REVISION_INSTRUCTION_MAX_CHARS),
		);

		await user.type(field, "Shorter");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("form")).toBeNull();
		expect(trigger).toHaveFocus();
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(onRequest).not.toHaveBeenCalled();
	});

	it("submits the section's key and the trimmed instruction, and closes the box", async () => {
		const user = userEvent.setup();
		const onRequest = vi.fn(() => true);
		render(<Harness onRequest={onRequest} />);
		await user.click(
			await screen.findByRole("button", {
				name: "Revise this section: 2. Pricing",
			}),
		);
		const submit = screen.getByRole("button", { name: "Revise" });
		expect(submit).toBeDisabled();

		await user.type(
			screen.getByLabelText("What should change in this section?"),
			"  Say that both phases are covered.  ",
		);
		await user.click(submit);
		expect(onRequest).toHaveBeenCalledTimes(1);
		expect(onRequest).toHaveBeenCalledWith({
			sectionKey: keyOf(MARKDOWN, "2. Pricing"),
			instruction: "Say that both phases are covered.",
		});
		expect(screen.queryByRole("form")).toBeNull();
	});

	it("submits with Ctrl+Enter; a request not taken keeps the box", async () => {
		const user = userEvent.setup();
		const onRequest = vi.fn(() => false);
		render(<Harness onRequest={onRequest} />);
		await user.click(
			await screen.findByRole("button", {
				name: "Revise this section: 1. Approach",
			}),
		);
		await user.type(
			screen.getByLabelText("What should change in this section?"),
			"Lead with the pilot.",
		);
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(onRequest).toHaveBeenCalledWith({
			sectionKey: keyOf(MARKDOWN, "1. Approach"),
			instruction: "Lead with the pilot.",
		});
		expect(
			screen.getByRole("form", { name: "Revise “1. Approach”" }),
		).toBeInTheDocument();
	});

	it("says so, and asks for nothing, when the editor's Markdown has no such section", async () => {
		const user = userEvent.setup();
		const onRequest = vi.fn(() => true);
		render(
			<Harness
				markdown={"# Example proposal\n\n## Something else\n\nText."}
				onRequest={onRequest}
			/>,
		);
		await user.click(
			await screen.findByRole("button", {
				name: "Revise this section: 2. Pricing",
			}),
		);
		await user.type(
			screen.getByLabelText("What should change in this section?"),
			"Shorter.",
		);
		await user.click(screen.getByRole("button", { name: "Revise" }));
		expect(onRequest).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"The revision was not applied: the section is no longer in the document.",
		);
	});
});

describe("Revise this section while the editor takes no input (Fizzy #2946)", () => {
	const PAUSED =
		"The editor isn't taking changes right now, so this can't be sent yet. Your instruction is kept.";

	it("keeps the box and what was typed, disables submit and says why; editable again, it submits", async () => {
		const user = userEvent.setup();
		const onRequest = vi.fn(() => true);
		let editor: Editor | null = null;
		render(
			<Harness
				onRequest={onRequest}
				onEditor={(ed) => {
					editor = ed;
				}}
			/>,
		);
		await user.click(
			await screen.findByRole("button", {
				name: "Revise this section: 2. Pricing",
			}),
		);
		const field = screen.getByLabelText(
			"What should change in this section?",
		);
		await user.type(field, "Say that both phases are covered.");

		// A review elsewhere freezes the editor.
		act(() => {
			(editor as unknown as Editor).setEditable(false);
		});
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Revise" }),
			).toBeDisabled();
		});
		expect(
			screen.getByRole("form", { name: "Revise “2. Pricing”" }),
		).toBeInTheDocument();
		expect(field).toHaveValue("Say that both phases are covered.");
		expect(field).toHaveFocus();
		expect(screen.getByText(PAUSED)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Revise" }),
		).toHaveAccessibleDescription(PAUSED);
		// The other heading's control is gone meanwhile; this one stays.
		expect(
			screen.queryByRole("button", {
				name: "Revise this section: 1. Approach",
			}),
		).toBeNull();
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(onRequest).not.toHaveBeenCalled();

		act(() => {
			(editor as unknown as Editor).setEditable(true);
		});
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Revise" }),
			).toBeEnabled();
		});
		expect(screen.queryByText(PAUSED)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Revise" }));
		expect(onRequest).toHaveBeenCalledWith({
			sectionKey: keyOf(MARKDOWN, "2. Pricing"),
			instruction: "Say that both phases are covered.",
		});
	});

	it("follows its heading when one above it goes, and closes, saying so, once its own is gone", async () => {
		const user = userEvent.setup();
		let editor: Editor | null = null;
		render(
			<Harness
				onRequest={vi.fn(() => true)}
				onEditor={(ed) => {
					editor = ed;
				}}
			/>,
		);
		await user.click(
			await screen.findByRole("button", {
				name: "Revise this section: 2. Pricing",
			}),
		);
		await user.type(
			screen.getByLabelText("What should change in this section?"),
			"Shorter.",
		);

		// The heading above it goes: the box stays with its own heading.
		act(() => {
			(editor as unknown as Editor).commands.setContent(
				HTML.replace("<h2>1. Approach</h2>", "<p>1. Approach</p>"),
			);
		});
		await waitFor(() => {
			expect(
				screen.queryByRole("button", {
					name: "Revise this section: 1. Approach",
				}),
			).toBeNull();
			expect(
				screen.getByRole("button", {
					name: "Revise this section: 2. Pricing",
				}),
			).toHaveAttribute("aria-expanded", "true");
			expect(
				screen.getByLabelText("What should change in this section?"),
			).toHaveValue("Shorter.");
		});

		// Its own heading goes: the box closes and says so.
		act(() => {
			(editor as unknown as Editor).commands.setContent(
				HTML.replace("<h2>2. Pricing</h2>", "<p>2. Pricing</p>"),
			);
		});
		expect(
			await screen.findByText(
				"The section's heading is no longer in the document, so its revision box was closed.",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("form")).toBeNull();
		expect(document.body).not.toHaveFocus();
	});
});

describe("resolveHeadingSectionKey", () => {
	it("resolves by position, and by text when the counts differ", () => {
		expect(
			resolveHeadingSectionKey(MARKDOWN, {
				index: 1,
				text: "2. Pricing",
				count: 2,
			}),
		).toBe(keyOf(MARKDOWN, "2. Pricing"));
		expect(
			resolveHeadingSectionKey(MARKDOWN, {
				index: 0,
				text: "2. Pricing",
				count: 3,
			}),
		).toBe(keyOf(MARKDOWN, "2. Pricing"));
		expect(
			resolveHeadingSectionKey(MARKDOWN, {
				index: 0,
				text: "3. Missing",
				count: 2,
			}),
		).toBeNull();
	});
});
