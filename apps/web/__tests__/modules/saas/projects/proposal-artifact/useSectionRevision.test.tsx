/**
 * A finding-driven revision of one section, reviewed in the editor (Fizzy
 * #2946).
 *
 * Pinned here, against a stand-in editor that holds markdown:
 *   - a new request saves the editor first, asks for the revision from the
 *     saved base, splices the candidate into the editor's current body —
 *     every other section byte-identical — says its review before the diff
 *     goes in, and leaves the editor read-only at the section's heading;
 *   - an edit anywhere in the editor while it is drafted, or a base that
 *     moved meanwhile, drops the candidate before anything is shown, since
 *     its accept is bound to the base the revision read;
 *   - the request's id is said once its review is shown;
 *   - every other status, a thrown error, a failed flush, no base and an
 *     editor that cannot start are answered once with their code;
 *   - Accept hands the editor the revised body with the FINDING descriptor
 *     and its token, and answers what the save said; Reject puts the body
 *     from before the review back byte for byte;
 *   - the offer of an earlier refused accept's text is dismissed when the
 *     next revision's review is shown and when it is saved, and kept when
 *     that revision ends with nothing to review;
 *   - an id runs once; an editor that goes away answers the request in
 *     hand as interrupted.
 */

import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reviseSection = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				reviseSection: (input: unknown) => reviseSection(input),
			},
		},
	},
}));
vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));

import {
	aiAcceptOfferToastId,
	type SectionRevisionAcceptAnswer,
	type SectionRevisionOutcome,
	type SectionRevisionRequest,
	useSectionRevision,
} from "@saas/projects/components/proposal-artifact/useSectionRevision";
import { toast } from "sonner";

const DOCUMENT = [
	"# Example proposal",
	"",
	"An opening paragraph for Example Org.",
	"",
	"## Approach",
	"",
	"We start with a pilot.",
	"",
	"## Pricing",
	"",
	"A fixed fee for the first phase.",
	"",
	"```mermaid",
	"flowchart LR",
	"  A --> B",
	"```",
	"",
	"## Timeline",
	"",
	"Four weeks.",
].join("\n");

const PRICING_KEY = keyOf(DOCUMENT, "Pricing");
const REVISED_PRICING =
	"A fixed fee covers both phases.\n\n```mermaid\nflowchart LR\n  A --> B\n```";
const BASE = { version: 4, contentHash: "hash-4" };

function keyOf(markdown: string, heading: string): string {
	const section = buildSectionMap(markdown).sections.find(
		(entry) => entry.headingText === heading,
	);
	if (!section) {
		throw new Error(`no section ${heading}`);
	}
	return section.key;
}

/** The lines of every section but `heading`'s, in order. */
function otherSections(markdown: string, heading: string): string {
	const lines = markdown.split("\n");
	const { sections } = buildSectionMap(markdown);
	return sections
		.filter((section) => section.headingText !== heading)
		.map((section) =>
			lines.slice(section.startLine - 1, section.endLine).join("\n"),
		)
		.join("\n---\n");
}

const DIFF = "\u0000diff\u0000";

/** A stand-in editor: it holds markdown; a diff reads as its new text. */
function makeEditor(initial: string) {
	const editor = {
		text: initial,
		editable: true,
		writes: [] as string[],
		commands: {
			setContent: (content: string) => {
				editor.writes.push(content);
				editor.text = content;
			},
		},
		setEditable: (value: boolean) => {
			editor.editable = value;
		},
	};
	return editor;
}
type FakeEditor = ReturnType<typeof makeEditor>;

function read(editor: FakeEditor | null): string | null {
	if (!editor) {
		return null;
	}
	return editor.text.startsWith(DIFF)
		? editor.text.slice(DIFF.length)
		: editor.text;
}

interface Setup {
	editor: FakeEditor;
	flushSave: ReturnType<typeof vi.fn>;
	resolveBase: ReturnType<typeof vi.fn>;
	blockedReason: ReturnType<typeof vi.fn>;
	heldElsewhere: ReturnType<typeof vi.fn>;
	beforePreview: ReturnType<typeof vi.fn>;
	onReviewShown: ReturnType<typeof vi.fn>;
	focusOnAnchor: ReturnType<typeof vi.fn>;
	saveAccept: ReturnType<typeof vi.fn>;
	settled: SectionRevisionOutcome[];
	order: string[];
}

function setup(initial = DOCUMENT): Setup {
	const order: string[] = [];
	const editor = makeEditor(initial);
	const original = editor.commands.setContent;
	editor.commands.setContent = (content: string) => {
		order.push("setContent");
		original(content);
	};
	return {
		editor,
		flushSave: vi.fn(async () => {
			order.push("flush");
			return true;
		}),
		resolveBase: vi.fn(() => BASE),
		blockedReason: vi.fn(() => null),
		heldElsewhere: vi.fn(() => false),
		beforePreview: vi.fn(() => {
			order.push("beforePreview");
		}),
		onReviewShown: vi.fn(() => {
			order.push("reviewShown");
		}),
		focusOnAnchor: vi.fn(),
		saveAccept: vi.fn(),
		settled: [],
		order,
	};
}

function mount(s: Setup, request: SectionRevisionRequest | null) {
	const seen = new Set<string>();
	return renderHook(
		({ asked }: { asked: SectionRevisionRequest | null }) =>
			useSectionRevision({
				projectId: "proj-1",
				documentId: "doc-1",
				editor: s.editor as never,
				request: asked,
				seen,
				getEditorMarkdownForSave: (ed) =>
					read(ed as unknown as FakeEditor | null),
				fromMarkdown: (markdown) => markdown,
				diffPartialText: (_before, after) => `${DIFF}${after}`,
				focusOnAnchor: s.focusOnAnchor,
				flushSave: s.flushSave,
				resolveBase: s.resolveBase,
				blockedReason: s.blockedReason,
				heldElsewhere: s.heldElsewhere,
				beforePreview: s.beforePreview,
				onReviewShown: s.onReviewShown,
				saveAccept: s.saveAccept,
				onSettled: (outcome) => s.settled.push(outcome),
			}),
		{ initialProps: { asked: request } },
	);
}

const REQUEST: SectionRevisionRequest = {
	id: "revision-1",
	runId: "run-1",
	findingId: "finding-1",
};

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		status: "CANDIDATE",
		sectionKey: PRICING_KEY,
		body: REVISED_PRICING,
		baseVersion: BASE.version,
		baseContentHash: BASE.contentHash,
		revisionToken: "token-example",
		...overrides,
	};
}

beforeEach(() => {
	reviseSection.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("a section revision (Fizzy #2946)", () => {
	it("saves the editor first, asks from the saved base, and shows the candidate in the target section only", async () => {
		const s = setup();
		reviseSection.mockImplementation(async () => {
			s.order.push("reviseSection");
			return candidate();
		});
		const { result } = mount(s, REQUEST);

		await waitFor(() => {
			expect(result.current.isReviewing).toBe(true);
		});
		expect(reviseSection).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
			runId: "run-1",
			findingId: "finding-1",
			baseVersion: 4,
			baseContentHash: "hash-4",
		});
		// Saved first; the review said before the diff goes in.
		expect(s.order).toEqual([
			"flush",
			"reviseSection",
			"beforePreview",
			"setContent",
			"reviewShown",
		]);
		expect(s.onReviewShown).toHaveBeenCalledTimes(1);
		expect(s.onReviewShown).toHaveBeenCalledWith("revision-1");
		const shown = read(s.editor) ?? "";
		expect(shown).toContain("A fixed fee covers both phases.");
		expect(shown).not.toContain("A fixed fee for the first phase.");
		expect(otherSections(shown, "Pricing")).toBe(
			otherSections(DOCUMENT, "Pricing"),
		);
		expect(s.editor.editable).toBe(false);
		expect(s.focusOnAnchor).toHaveBeenCalledWith(s.editor, "Pricing");
		expect(result.current.sectionHeading).toBe("Pricing");
		expect(s.settled).toEqual([]);
	});

	it("drops the candidate when another section was edited while it is drafted, or the target section was", async () => {
		const elsewhere = setup();
		reviseSection.mockImplementation(async () => {
			elsewhere.editor.text = DOCUMENT.replace(
				"Four weeks.",
				"Four weeks, typed meanwhile.",
			);
			return candidate();
		});
		const first = mount(elsewhere, REQUEST);
		await waitFor(() => {
			expect(elsewhere.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "STALE" },
			]);
		});
		expect(first.result.current.isActive).toBe(false);
		// The edit made meanwhile stays; nothing of the candidate went in.
		expect(elsewhere.editor.writes).toEqual([]);
		expect(read(elsewhere.editor)).toContain(
			"Four weeks, typed meanwhile.",
		);
		expect(elsewhere.beforePreview).not.toHaveBeenCalled();
		expect(elsewhere.onReviewShown).not.toHaveBeenCalled();

		const target = setup();
		reviseSection.mockImplementation(async () => {
			target.editor.text = DOCUMENT.replace(
				"A fixed fee for the first phase.",
				"A fixed fee, typed meanwhile.",
			);
			return candidate();
		});
		const second = mount(target, { ...REQUEST, id: "revision-2" });
		await waitFor(() => {
			expect(target.settled).toEqual([
				{
					id: "revision-2",
					result: "refused",
					code: "SECTION_CHANGED_MEANWHILE",
				},
			]);
		});
		expect(second.result.current.isActive).toBe(false);
		expect(target.editor.writes).toEqual([]);
		expect(target.beforePreview).not.toHaveBeenCalled();
	});

	it("drops the candidate when the saved base moved while it is drafted, the editor's body unchanged", async () => {
		const s = setup();
		reviseSection.mockImplementation(async () => {
			s.resolveBase.mockReturnValue({
				version: 5,
				contentHash: "hash-5",
			});
			return candidate();
		});
		const { result } = mount(s, REQUEST);
		await waitFor(() => {
			expect(s.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "STALE" },
			]);
		});
		expect(result.current.isActive).toBe(false);
		expect(s.editor.writes).toEqual([]);
		expect(s.editor.editable).toBe(true);
		expect(s.beforePreview).not.toHaveBeenCalled();
		expect(s.onReviewShown).not.toHaveBeenCalled();
	});

	it("drops the candidate when the base is gone once it is drafted", async () => {
		const s = setup();
		reviseSection.mockImplementation(async () => {
			s.resolveBase.mockReturnValue(null);
			return candidate();
		});
		mount(s, REQUEST);
		await waitFor(() => {
			expect(s.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "STALE" },
			]);
		});
		expect(s.editor.writes).toEqual([]);
	});

	it.each([
		["STALE", "refused"],
		["SECTION_NOT_FOUND", "refused"],
		["FINDING_SECTION_CHANGED", "refused"],
		["INVALID_CANDIDATE", "refused"],
		["RESPONSE_ECHOED", "refused"],
		["AI_PROVIDER_NOT_CONFIGURED", "failed"],
		["PROPOSAL_PROMPT_NOT_BOUND", "failed"],
		["RATE_LIMITED", "failed"],
	])(
		"answers %s once, as %s, and leaves the editor alone",
		async (status, verdict) => {
			const s = setup();
			reviseSection.mockResolvedValue({ status, message: "unused" });
			const { result } = mount(s, REQUEST);
			await waitFor(() => {
				expect(s.settled).toHaveLength(1);
			});
			expect(s.settled[0]).toEqual({
				id: "revision-1",
				result: verdict,
				code: status,
			});
			expect(result.current.isActive).toBe(false);
			expect(s.editor.writes).toEqual([]);
			expect(s.editor.editable).toBe(true);
		},
	);

	it("answers a thrown error as failed with its code", async () => {
		const s = setup();
		reviseSection.mockRejectedValue(
			Object.assign(new Error("Forbidden"), {
				code: "FORBIDDEN",
				data: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" },
			}),
		);
		mount(s, REQUEST);
		await waitFor(() => {
			expect(s.settled).toEqual([
				{
					id: "revision-1",
					result: "failed",
					code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
				},
			]);
		});
	});

	it("asks for nothing when the editor's save fails, when there is no base, or when the editor cannot start one", async () => {
		const unsaved = setup();
		unsaved.flushSave.mockResolvedValue(false);
		mount(unsaved, REQUEST);
		await waitFor(() => {
			expect(unsaved.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "SAVE_FAILED" },
			]);
		});

		const noBase = setup();
		noBase.resolveBase.mockReturnValue(null);
		mount(noBase, REQUEST);
		await waitFor(() => {
			expect(noBase.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "NO_BASE" },
			]);
		});

		const busy = setup();
		busy.blockedReason.mockReturnValue("HELD_ELSEWHERE");
		mount(busy, REQUEST);
		await waitFor(() => {
			expect(busy.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "HELD_ELSEWHERE" },
			]);
		});
		expect(busy.flushSave).not.toHaveBeenCalled();
		expect(reviseSection).not.toHaveBeenCalled();
	});

	it("drops a candidate that answers while another editor's review holds this one", async () => {
		const s = setup();
		reviseSection.mockImplementation(async () => {
			s.heldElsewhere.mockReturnValue(true);
			return candidate();
		});
		mount(s, REQUEST);
		await waitFor(() => {
			expect(s.settled).toEqual([
				{ id: "revision-1", result: "refused", code: "HELD_ELSEWHERE" },
			]);
		});
		expect(s.editor.writes).toEqual([]);
	});

	it("Accept saves the revised body with the FINDING descriptor and its token, and answers what the save said", async () => {
		const s = setup();
		reviseSection.mockResolvedValue(candidate());
		const { result } = mount(s, REQUEST);
		await waitFor(() => {
			expect(result.current.isReviewing).toBe(true);
		});
		const revised = read(s.editor);

		act(() => {
			result.current.accept();
		});
		expect(result.current.isApplying).toBe(true);
		expect(s.saveAccept).toHaveBeenCalledTimes(1);
		const accept = s.saveAccept.mock.calls[0][0] as {
			content: string;
			from: string;
			aiReview: unknown;
			onAnswer: (answer: SectionRevisionAcceptAnswer) => void;
		};
		expect(accept.content).toBe(revised);
		expect(accept.from).toBe(DOCUMENT);
		expect(accept.aiReview).toEqual({
			kind: "FINDING",
			runId: "run-1",
			findingId: "finding-1",
			revisionToken: "token-example",
		});
		// Still held until the save answers.
		expect(s.settled).toEqual([]);

		act(() => {
			accept.onAnswer({ kind: "saved" });
		});
		expect(s.settled).toEqual([{ id: "revision-1", result: "accepted" }]);
		expect(result.current.isActive).toBe(false);
	});

	it("a refused accept is answered refused with the code; a save that did not land, failed", async () => {
		for (const [answer, expected] of [
			[
				{ kind: "refused", code: "REVISION_OUTSIDE_TARGET" },
				{ result: "refused", code: "REVISION_OUTSIDE_TARGET" },
			],
			[
				{ kind: "notSaved", code: "CONFLICT" },
				{ result: "failed", code: "CONFLICT" },
			],
		] as const) {
			const s = setup();
			reviseSection.mockResolvedValue(candidate());
			const { result, unmount } = mount(s, REQUEST);
			await waitFor(() => {
				expect(result.current.isReviewing).toBe(true);
			});
			act(() => {
				result.current.accept();
			});
			act(() => {
				s.saveAccept.mock.calls[0][0].onAnswer(answer);
			});
			expect(s.settled).toEqual([{ id: "revision-1", ...expected }]);
			unmount();
		}
	});

	it("dismisses the offer of an earlier refused accept's text when the next revision's review is shown, and when it is saved", async () => {
		const offer = aiAcceptOfferToastId("doc-1");
		const s = setup();
		reviseSection.mockImplementation(async () => {
			// Still offered while the revision is drafted.
			expect(toast.dismiss).not.toHaveBeenCalled();
			return candidate();
		});
		const { result } = mount(s, REQUEST);
		await waitFor(() => {
			expect(result.current.isReviewing).toBe(true);
		});
		expect(toast.dismiss).toHaveBeenCalledTimes(1);
		expect(toast.dismiss).toHaveBeenCalledWith(offer);

		act(() => {
			result.current.accept();
		});
		act(() => {
			s.saveAccept.mock.calls[0][0].onAnswer({ kind: "saved" });
		});
		expect(toast.dismiss).toHaveBeenCalledTimes(2);
		expect(toast.dismiss).toHaveBeenLastCalledWith(offer);

		// A request the editor cannot start leaves the offer where it is.
		vi.mocked(toast.dismiss).mockClear();
		const busy = setup();
		busy.blockedReason.mockReturnValue("HELD_ELSEWHERE");
		mount(busy, { ...REQUEST, id: "revision-2" });
		await waitFor(() => {
			expect(busy.settled).toHaveLength(1);
		});
		expect(toast.dismiss).not.toHaveBeenCalled();
	});

	// The user would otherwise lose the refused text to a revision that
	// never showed a candidate.
	it.each([
		[
			"a status other than a candidate",
			(s: Setup) => {
				reviseSection.mockResolvedValue({
					status: "RATE_LIMITED",
					message: "unused",
				});
				return s;
			},
			"RATE_LIMITED",
		],
		[
			"a thrown error",
			(s: Setup) => {
				reviseSection.mockRejectedValue(
					Object.assign(new Error("Network"), {
						data: { code: "NETWORK" },
					}),
				);
				return s;
			},
			"NETWORK",
		],
		[
			"a failed save of the editor",
			(s: Setup) => {
				s.flushSave.mockResolvedValue(false);
				return s;
			},
			"SAVE_FAILED",
		],
		[
			"no base",
			(s: Setup) => {
				s.resolveBase.mockReturnValue(null);
				return s;
			},
			"NO_BASE",
		],
		[
			"a candidate whose base moved meanwhile",
			(s: Setup) => {
				reviseSection.mockImplementation(async () => {
					s.resolveBase.mockReturnValue({
						version: 5,
						contentHash: "hash-5",
					});
					return candidate();
				});
				return s;
			},
			"STALE",
		],
		[
			"a candidate held by another editor's review",
			(s: Setup) => {
				reviseSection.mockImplementation(async () => {
					s.heldElsewhere.mockReturnValue(true);
					return candidate();
				});
				return s;
			},
			"HELD_ELSEWHERE",
		],
	])(
		"keeps the offer of an earlier refused accept's text after %s",
		async (_name, arrange, code) => {
			const s = arrange(setup());
			mount(s, REQUEST);
			await waitFor(() => {
				expect(s.settled).toHaveLength(1);
			});
			expect(s.settled[0]?.code).toBe(code);
			expect(toast.dismiss).not.toHaveBeenCalled();
		},
	);

	it("Reject puts back the body from before the review, byte for byte", async () => {
		const s = setup();
		reviseSection.mockResolvedValue(candidate());
		const { result } = mount(s, REQUEST);
		await waitFor(() => {
			expect(result.current.isReviewing).toBe(true);
		});
		act(() => {
			expect(result.current.reject()).toBe(true);
		});
		expect(read(s.editor)).toBe(DOCUMENT);
		expect(s.settled).toEqual([{ id: "revision-1", result: "rejected" }]);
		expect(s.saveAccept).not.toHaveBeenCalled();
	});

	it("runs an id once, and a new id again", async () => {
		const s = setup();
		reviseSection.mockResolvedValue({ status: "STALE" });
		const { rerender } = mount(s, REQUEST);
		await waitFor(() => {
			expect(s.settled).toHaveLength(1);
		});
		rerender({ asked: { ...REQUEST } });
		await act(async () => {
			await Promise.resolve();
		});
		expect(reviseSection).toHaveBeenCalledTimes(1);
		rerender({ asked: { ...REQUEST, id: "revision-2" } });
		await waitFor(() => {
			expect(s.settled).toHaveLength(2);
		});
		expect(reviseSection).toHaveBeenCalledTimes(2);
	});

	it("an editor that goes away answers the request in hand as interrupted, and its late answer touches nothing", async () => {
		const s = setup();
		let release: (value: unknown) => void = () => {};
		reviseSection.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const { unmount } = mount(s, REQUEST);
		await waitFor(() => {
			expect(reviseSection).toHaveBeenCalled();
		});
		unmount();
		expect(s.settled).toEqual([
			{ id: "revision-1", result: "failed", code: "INTERRUPTED" },
		]);
		await act(async () => {
			release(candidate());
			await Promise.resolve();
		});
		expect(s.settled).toHaveLength(1);
		expect(s.editor.writes).toEqual([]);
	});

	it("an editor that goes away while an accept's save is in flight leaves the answer to that save", async () => {
		const s = setup();
		reviseSection.mockResolvedValue(candidate());
		const { result, unmount } = mount(s, REQUEST);
		await waitFor(() => {
			expect(result.current.isReviewing).toBe(true);
		});
		act(() => {
			result.current.accept();
		});
		unmount();
		expect(s.settled).toEqual([]);
		act(() => {
			s.saveAccept.mock.calls[0][0].onAnswer({ kind: "saved" });
		});
		expect(s.settled).toEqual([{ id: "revision-1", result: "accepted" }]);
	});
});
