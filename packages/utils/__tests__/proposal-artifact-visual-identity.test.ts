/**
 * Generated visuals' identity in a Proposal's Main (Fizzy #2946): the
 * `%% fabric-visual:` marker, the source hash that survives the editor's
 * round trip, and the classification of every diagram fence against the
 * document's stored specs.
 */

import { describe, expect, it } from "vitest";
import { preserveVisualSlots } from "../lib/glossy/visual-slots";
import {
	readFigureKind,
	tryRenderFigure,
	withFigureKind,
} from "../lib/proposal-artifact/proposal-figures";
import { parseStatTiles } from "../lib/proposal-artifact/stat-tiles";
import { mintVisualId } from "../lib/proposal-artifact/visual-id-server";
import {
	classifyVisualFences,
	DIAGRAM_CAPTION_MAX_CHARS,
	diagramFences,
	diagramHeaderLine,
	diagramSectionAt,
	diagramSectionFingerprint,
	isFlowchartSource,
	isVisualId,
	isVisualOrigin,
	MINTED_VISUAL_ID_LENGTH,
	normaliseVisualSource,
	preserveVisualMarkers,
	readDiagramCaption,
	readVisualMarker,
	VISUAL_HASH_PATTERN,
	VISUAL_ORIGIN,
	VISUAL_ORIGINS,
	type VisualSpecSummary,
	visualMarkerLine,
	visualSourceHash,
	visualSpecHash,
	withDiagramCaption,
} from "../lib/proposal-artifact/visual-identity";
import {
	toMermaidFence,
	toMermaidFenceBody,
} from "../lib/proposal-artifact/visual-insert";

const lines = (...parts: string[]) => parts.join("\n");

const ID = "k3v9q2m7x1a8c4d6";
const OTHER_ID = "p0q1r2s3t4u5v6w7";

const SOURCE = lines(
	"flowchart LR",
	'  s0["Discovery"] --> s1["Launch"]',
	"  style s0 fill:#eef2ff,stroke:#4f46e5",
);

/** The fence body between the fence lines. */
const bodyOf = (fence: string) => fence.split("\n").slice(1, -1).join("\n");

const FENCE = toMermaidFence(SOURCE, ID);
const HASH = visualSourceHash(bodyOf(FENCE));

const row = (
	overrides: Partial<VisualSpecSummary> = {},
): VisualSpecSummary => ({
	visualId: ID,
	sourceHash: HASH,
	kind: "flow",
	origin: "STEP",
	...overrides,
});

const document = (...blocks: string[]) =>
	lines("# Example Proposal", "", "## Delivery", "", ...blocks, "");

describe("marker", () => {
	it("writes and reads the marker line", () => {
		expect(visualMarkerLine(ID)).toBe(`%% fabric-visual: ${ID}`);
		expect(readVisualMarker(bodyOf(FENCE))).toEqual({
			visualId: ID,
			source: SOURCE,
		});
	});

	it("accepts ids of 12 to 32 lowercase letters or digits, as stat tiles do", () => {
		for (const id of ["a1b2c3d4e5f6", "a".repeat(32)]) {
			expect(
				readVisualMarker(`%% fabric-visual: ${id}\nA`).visualId,
			).toBe(id);
			const tiles = parseStatTiles(`%% fabric-visual: ${id}\nSites: 3`);
			expect(tiles.ok && tiles.visualId).toBe(id);
		}
		for (const id of ["a1b2c3d4e5", "a".repeat(33), "A1B2C3D4E5F6G7"]) {
			expect(
				readVisualMarker(`%% fabric-visual: ${id}\nA`).visualId,
			).toBe(null);
			expect(parseStatTiles(`%% fabric-visual: ${id}\nSites: 3`).ok).toBe(
				false,
			);
			expect(() => visualMarkerLine(id)).toThrow();
		}
	});

	it("reads a marker only on the first non-blank line", () => {
		expect(
			readVisualMarker(`\n\n%% fabric-visual: ${ID}\nA`).visualId,
		).toBe(ID);
		expect(
			readVisualMarker(`flowchart LR\n%% fabric-visual: ${ID}`).visualId,
		).toBe(null);
	});
});

describe("source hash", () => {
	it("is versioned and leaves the marker out", () => {
		expect(HASH).toMatch(VISUAL_HASH_PATTERN);
		expect(HASH.startsWith("v1:")).toBe(true);
		expect(HASH).toBe(visualSourceHash(SOURCE));
		expect(visualSourceHash(bodyOf(toMermaidFence(SOURCE, OTHER_ID)))).toBe(
			HASH,
		);
	});

	it("ignores line endings, trailing whitespace and surrounding blank lines", () => {
		const reformatted = `\r\n%% fabric-visual: ${ID}\r\n\r\n${SOURCE.split(
			"\n",
		)
			.map((line) => `${line}  \t`)
			.join("\r\n")}\r\n\r\n`;

		expect(visualSourceHash(reformatted)).toBe(HASH);
		expect(normaliseVisualSource(" \nA  \n  B\n\n")).toBe("A\n  B");
	});

	it("changes when a label or the indentation changes", () => {
		expect(visualSourceHash(SOURCE.replace("Launch", "Go-live"))).not.toBe(
			HASH,
		);
		expect(visualSourceHash(SOURCE.replace("  s0", "s0"))).not.toBe(HASH);
	});

	it("hashes a fence without a figure line exactly as before the line existed", () => {
		expect(HASH).toBe("v1:7ffb6f12ac204b9e");
	});

	it("leaves the figure line out, with or without a caption", () => {
		const marked = bodyOf(FENCE);
		const figured = withFigureKind(marked, "process");

		expect(figured.split("\n")[1]).toBe("%% figure: process");
		expect(visualSourceHash(figured)).toBe(HASH);
		expect(visualSourceHash(withFigureKind(figured, "layers"))).toBe(HASH);
		expect(visualSourceHash(withFigureKind(figured, null))).toBe(HASH);
		expect(
			visualSourceHash(withDiagramCaption(figured, "Delivery plan")),
		).toBe(HASH);
		expect(visualSourceHash(withFigureKind(SOURCE, "timeline"))).toBe(HASH);
		// Only the leading comment block holds a figure line.
		expect(visualSourceHash(lines(SOURCE, "%% figure: process"))).not.toBe(
			HASH,
		);
	});

	it("keeps a malformed marker in the hashed source", () => {
		expect(visualSourceHash(`%% fabric-visual: BAD\n${SOURCE}`)).not.toBe(
			HASH,
		);
	});
});

describe("spec hash", () => {
	it("does not depend on key order", () => {
		const a = { kind: "flow", steps: [{ label: "A", lane: "Ops" }] };
		const b = { steps: [{ lane: "Ops", label: "A" }], kind: "flow" };

		expect(visualSpecHash(a)).toBe(visualSpecHash(b));
		expect(visualSpecHash(a)).toMatch(VISUAL_HASH_PATTERN);
		expect(visualSpecHash({ ...a, title: "T" })).not.toBe(
			visualSpecHash(a),
		);
	});
});

describe("classifyVisualFences", () => {
	it("an unchanged generated fence is generated, with its origin", () => {
		expect(classifyVisualFences(document(FENCE), [row()])).toEqual([
			{
				ordinal: 0,
				visualId: ID,
				sourceHash: HASH,
				state: "generated",
				origin: "STEP",
			},
		]);
		expect(
			classifyVisualFences(document(FENCE), [
				row({ origin: "INSTRUCTION" }),
			])[0],
		).toMatchObject({ state: "generated", origin: "INSTRUCTION" });
	});

	it("a fence with one changed node label is edited", () => {
		const edited = FENCE.replace("Launch", "Go-live");

		expect(classifyVisualFences(document(edited), [row()])).toEqual([
			{
				ordinal: 0,
				visualId: ID,
				sourceHash: visualSourceHash(bodyOf(edited)),
				state: "edited",
			},
		]);
	});

	it("the second fence carrying the same id is detached", () => {
		const result = classifyVisualFences(document(FENCE, "", FENCE), [
			row(),
		]);

		expect(result.map((fence) => fence.state)).toEqual([
			"generated",
			"detached",
		]);
		expect(result[1]).toMatchObject({ ordinal: 1, visualId: ID });
		expect(result[1].origin).toBeUndefined();
	});

	it("a fence copied from another document has no row here and is detached", () => {
		const copied = toMermaidFence(SOURCE, OTHER_ID);

		expect(classifyVisualFences(document(copied), [row()])).toEqual([
			{
				ordinal: 0,
				visualId: OTHER_ID,
				sourceHash: HASH,
				state: "detached",
			},
		]);
	});

	it("a hand-written fence is none", () => {
		const handWritten = toMermaidFence("flowchart LR\nA --> B");

		expect(classifyVisualFences(document(handWritten), [row()])).toEqual([
			{
				ordinal: 0,
				sourceHash: visualSourceHash("flowchart LR\nA --> B"),
				state: "none",
			},
		]);
	});

	it("a marker written onto a person's own fence is edited, and does not follow a changed body", () => {
		const handSource = "flowchart LR\nA --> B";
		const forged = toMermaidFence(handSource, ID);

		expect(classifyVisualFences(document(forged), [row()])).toEqual([
			{
				ordinal: 0,
				visualId: ID,
				sourceHash: visualSourceHash(handSource),
				state: "edited",
			},
		]);

		const next = document(toMermaidFence("flowchart LR\nA --> C"));
		const preserved = preserveVisualMarkers(document(forged), next);
		expect(preserved).toBe(next);
		expect(classifyVisualFences(preserved, [row()])[0].state).toBe("none");
	});

	it("an older version restored is generated against its own row", () => {
		const newer = toMermaidFence(SOURCE.replace("Launch", "Go-live"), ID);
		const rows = [
			row(),
			row({
				sourceHash: visualSourceHash(bodyOf(newer)),
				origin: "INSTRUCTION",
			}),
		];

		expect(classifyVisualFences(document(FENCE), rows)[0]).toMatchObject({
			state: "generated",
			origin: "STEP",
		});
		expect(classifyVisualFences(document(newer), rows)[0]).toMatchObject({
			state: "generated",
			origin: "INSTRUCTION",
		});
	});

	it("counts only diagram fences, nested ones included, in document order", () => {
		const nested = FENCE.split("\n")
			.map((line) => `   ${line}`)
			.join("\n");
		const markdown = document(
			"```stat-tiles",
			`%% fabric-visual: ${OTHER_ID}`,
			"Sites: 3",
			"```",
			"",
			"```ts",
			"const a = 1;",
			"```",
			"",
			"1. Phases:",
			"",
			nested,
			"",
			toMermaidFence("flowchart LR\nA --> B"),
		);

		expect(
			classifyVisualFences(markdown, [row()]).map(
				({ ordinal, state }) => ({
					ordinal,
					state,
				}),
			),
		).toEqual([
			{ ordinal: 0, state: "generated" },
			{ ordinal: 1, state: "none" },
		]);
	});

	it("reads CRLF bodies as LF", () => {
		expect(
			classifyVisualFences(document(FENCE).replace(/\n/g, "\r\n"), [
				row(),
			])[0],
		).toMatchObject({ state: "generated" });
	});
});

describe("preserveVisualMarkers", () => {
	const MARKER = visualMarkerLine(ID);
	const bare = toMermaidFence(SOURCE);
	/** `text` with every line equal to `line` taken out. */
	const without = (text: string, line: string) =>
		text
			.split("\n")
			.filter((candidate) => candidate.trim() !== line)
			.join("\n");

	it("puts back a dropped marker on an unchanged diagram and changes nothing else", () => {
		const previous = document(FENCE);
		const next = lines(
			"# Example Proposal",
			"",
			"Rewritten intro.",
			"",
			bare,
			"",
		);

		const result = preserveVisualMarkers(previous, next);

		expect(result).toBe(
			lines("# Example Proposal", "", "Rewritten intro.", "", FENCE, ""),
		);
		expect(without(result, MARKER)).toBe(next);
		expect(classifyVisualFences(result, [row()])[0].state).toBe(
			"generated",
		);
	});

	it("does not mark a diagram whose body changed", () => {
		const next = document(bare.replace("Launch", "Go-live"));

		expect(preserveVisualMarkers(document(FENCE), next)).toBe(next);
	});

	it("leaves a kept marker alone, even when its body changed", () => {
		const edited = FENCE.replace("Launch", "Go-live");
		const next = document(edited, "", bare);

		expect(preserveVisualMarkers(document(FENCE), next)).toBe(next);
	});

	it("restores the right one of two identical diagrams without duplicating an id", () => {
		const second = toMermaidFence(SOURCE, OTHER_ID);
		const previous = document(FENCE, "", second);
		const next = document(FENCE, "", bare);

		const result = preserveVisualMarkers(previous, next);

		expect(result).toBe(previous);
		expect(
			classifyVisualFences(result, [
				row(),
				row({ visualId: OTHER_ID }),
			]).map((fence) => [fence.visualId, fence.state]),
		).toEqual([
			[ID, "generated"],
			[OTHER_ID, "generated"],
		]);
	});

	it("uses each marker once, in order", () => {
		const second = toMermaidFence(SOURCE, OTHER_ID);
		const previous = document(FENCE, "", second);

		expect(preserveVisualMarkers(previous, document(bare, "", bare))).toBe(
			previous,
		);
		expect(
			preserveVisualMarkers(document(FENCE), document(bare, "", bare)),
		).toBe(document(FENCE, "", bare));
	});

	it("returns next itself when previous holds no marker", () => {
		const next = document(bare);

		expect(preserveVisualMarkers(document(bare), next)).toBe(next);
		expect(preserveVisualMarkers(null, next)).toBe(next);
		expect(preserveVisualMarkers(undefined, next)).toBe(next);
		expect(preserveVisualMarkers(document(FENCE), "No diagrams.")).toBe(
			"No diagrams.",
		);
	});

	it("keeps CRLF line endings byte for byte", () => {
		const next = document(bare).replace(/\n/g, "\r\n");

		const result = preserveVisualMarkers(document(FENCE), next);

		expect(result).toBe(document(FENCE).replace(/\n/g, "\r\n"));
	});

	it("restores a marker inside a blockquote and a list item with their prefixes", () => {
		const quoted = (fence: string) =>
			fence
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
		const listed = (fence: string) =>
			fence
				.split("\n")
				.map((line, index) => `${index === 0 ? "- " : "  "}${line}`)
				.join("\n");

		expect(
			preserveVisualMarkers(
				document(quoted(FENCE)),
				document(quoted(bare)),
			),
		).toBe(document(quoted(FENCE)));
		expect(
			preserveVisualMarkers(
				document(listed(FENCE)),
				document(listed(bare)),
			),
		).toBe(document(listed(FENCE)));
	});

	it("does not mark a fence that would stop reading as a diagram", () => {
		const unlabelled = lines("```", SOURCE, "```");
		const next = document(unlabelled);

		expect(preserveVisualMarkers(document(FENCE), next)).toBe(next);
	});

	describe("figure line", () => {
		const marked = bodyOf(FENCE);
		const fenced = (body: string) => lines("```mermaid", body, "```");
		const FIGURED = fenced(withFigureKind(marked, "process"));
		const CAPTIONED = fenced(
			withFigureKind(
				withDiagramCaption(marked, "Delivery plan"),
				"process",
			),
		);

		it("comes back with a dropped marker", () => {
			const result = preserveVisualMarkers(
				document(FIGURED),
				document(bare),
			);

			expect(result).toBe(document(FIGURED));
			expect(classifyVisualFences(result, [row()])[0].state).toBe(
				"generated",
			);
		});

		it("comes back when the writer kept the marker", () => {
			expect(
				preserveVisualMarkers(document(FIGURED), document(FENCE)),
			).toBe(document(FIGURED));
		});

		it("goes back after the caption, as marker, caption, figure", () => {
			const captionOnly = fenced(
				withDiagramCaption(SOURCE, "Delivery plan"),
			);
			const markedCaptionOnly = fenced(
				withDiagramCaption(marked, "Delivery plan"),
			);

			expect(
				preserveVisualMarkers(
					document(CAPTIONED),
					document(captionOnly),
				),
			).toBe(document(CAPTIONED));
			expect(
				preserveVisualMarkers(
					document(CAPTIONED),
					document(markedCaptionOnly),
				),
			).toBe(document(CAPTIONED));
			expect(
				diagramFences(document(CAPTIONED))[0].value.split("\n"),
			).toEqual([
				MARKER,
				"%% caption: Delivery plan",
				"%% figure: process",
				...SOURCE.split("\n"),
			]);
		});

		it("keeps CRLF line endings and container prefixes", () => {
			const quoted = (fence: string) =>
				fence
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n");
			const crlf = (text: string) => text.replace(/\n/g, "\r\n");

			expect(
				preserveVisualMarkers(
					document(CAPTIONED),
					crlf(
						document(
							fenced(withDiagramCaption(SOURCE, "Delivery plan")),
						),
					),
				),
			).toBe(crlf(document(CAPTIONED)));
			expect(
				preserveVisualMarkers(
					document(quoted(FIGURED)),
					document(quoted(FENCE)),
				),
			).toBe(document(quoted(FIGURED)));
		});

		it("is not restored into a changed diagram, or over the writer's own figure line", () => {
			const changed = document(FENCE.replace("Launch", "Go-live"));
			const ownLine = document(
				fenced(withFigureKind(marked, "timeline")),
			);
			const unknownKind = document(
				fenced(lines(MARKER, "%% figure: swimlane", SOURCE)),
			);

			expect(preserveVisualMarkers(document(FIGURED), changed)).toBe(
				changed,
			);
			expect(preserveVisualMarkers(document(FIGURED), ownLine)).toBe(
				ownLine,
			);
			expect(preserveVisualMarkers(document(FIGURED), unknownKind)).toBe(
				unknownKind,
			);
		});

		it("keeps a writer's `%% figure: none`, which draws the fence as Mermaid", () => {
			const palette = {
				ink: "#16171a",
				onInk: "#ffffff",
				primary: "#c2410c",
				onPrimary: "#ffffff",
				tint: "#fbefe9",
				border: "#d9dade",
				surface: "#ffffff",
				muted: "#5b5e66",
			};
			const optedOut = fenced(lines(MARKER, "%% figure: none", SOURCE));
			const unmarked = fenced(lines("%% figure: none", SOURCE));

			expect(
				preserveVisualMarkers(document(FIGURED), document(optedOut)),
			).toBe(document(optedOut));
			expect(
				preserveVisualMarkers(document(FIGURED), document(unmarked)),
			).toBe(document(optedOut));
			expect(
				classifyVisualFences(document(optedOut), [row()])[0].state,
			).toBe("generated");

			const body = bodyOf(optedOut);
			expect(readFigureKind(body)).toBeNull();
			expect(tryRenderFigure(body, palette)).toBeNull();
			expect(tryRenderFigure(bodyOf(FIGURED), palette)).not.toBeNull();
		});

		it("restores each figure line to its own diagram", () => {
			const second = toMermaidFence(SOURCE, OTHER_ID);
			const previous = document(FIGURED, "", second);

			expect(
				preserveVisualMarkers(previous, document(FENCE, "", bare)),
			).toBe(previous);
		});
	});

	it("composes with visual slot preservation", () => {
		const slot =
			'<visual-slot data-slot-id="slot-a" data-kind="flow" data-hint="Phases"></visual-slot>';
		const previous = document(slot, "", FENCE);
		const next = document(bare);

		const result = preserveVisualMarkers(
			previous,
			preserveVisualSlots(previous, next),
		);

		expect(result).toContain(slot);
		expect(result).toContain(FENCE);
		expect(classifyVisualFences(result, [row()])[0].state).toBe(
			"generated",
		);
	});
});

describe("diagram caption", () => {
	const MARKER = visualMarkerLine(ID);
	const marked = bodyOf(FENCE);

	it("writes the caption line right after the marker, which stays first", () => {
		const captioned = withDiagramCaption(marked, "Delivery plan");

		expect(captioned.split("\n").slice(0, 3)).toEqual([
			MARKER,
			"%% caption: Delivery plan",
			"flowchart LR",
		]);
		expect(readVisualMarker(captioned).visualId).toBe(ID);
		expect(readDiagramCaption(captioned)).toBe("Delivery plan");
	});

	it("writes it first in a diagram without a marker", () => {
		const captioned = withDiagramCaption(SOURCE, "Delivery plan");

		expect(captioned).toBe(lines("%% caption: Delivery plan", SOURCE));
		expect(diagramHeaderLine(captioned)).toBe("flowchart LR");
	});

	it("replaces an existing caption and removes it on null or empty", () => {
		const captioned = withDiagramCaption(marked, "Delivery plan");
		const renamed = withDiagramCaption(captioned, "Launch plan");

		expect(readDiagramCaption(renamed)).toBe("Launch plan");
		expect(renamed.match(/%% caption:/g)).toHaveLength(1);
		expect(withDiagramCaption(captioned, null)).toBe(marked);
		expect(withDiagramCaption(captioned, "   ")).toBe(marked);
	});

	it("returns the source itself when there is nothing to change", () => {
		expect(withDiagramCaption(SOURCE, null)).toBe(SOURCE);
		const captioned = withDiagramCaption(SOURCE, "Delivery plan");
		expect(withDiagramCaption(captioned, "Delivery plan")).toBe(captioned);
	});

	it("writes the caption above a figure line, with or without a marker", () => {
		expect(
			withDiagramCaption(
				withFigureKind(marked, "process"),
				"Delivery plan",
			)
				.split("\n")
				.slice(0, 4),
		).toEqual([
			MARKER,
			"%% caption: Delivery plan",
			"%% figure: process",
			"flowchart LR",
		]);
		expect(
			withDiagramCaption(
				withFigureKind(SOURCE, "process"),
				"Delivery plan",
			),
		).toBe(
			lines("%% caption: Delivery plan", "%% figure: process", SOURCE),
		);
	});

	it("moves a caption written above the marker back below it", () => {
		const misplaced = lines("%% caption: Delivery plan", marked);

		expect(withDiagramCaption(misplaced, "Delivery plan")).toBe(
			withDiagramCaption(marked, "Delivery plan"),
		);
	});

	it("keeps the caption to one clean line of bounded length", () => {
		const captioned = withDiagramCaption(
			SOURCE,
			"  Delivery\nplan\u0000 \u2028 for\tAcme  ",
		);

		expect(readDiagramCaption(captioned)).toBe("Delivery plan for Acme");
		expect(captioned.split("\n")).toHaveLength(
			SOURCE.split("\n").length + 1,
		);
		const long = readDiagramCaption(
			withDiagramCaption(
				SOURCE,
				"x".repeat(DIAGRAM_CAPTION_MAX_CHARS + 50),
			),
		);
		expect(long).toHaveLength(DIAGRAM_CAPTION_MAX_CHARS);
	});

	it("reads a caption only from the leading comment block", () => {
		const late = lines(SOURCE, "%% caption: Not a caption");

		expect(readDiagramCaption(late)).toBeNull();
		expect(withDiagramCaption(late, null)).toBe(late);
		expect(readDiagramCaption(lines("%%caption:   Spaced  ", SOURCE))).toBe(
			"Spaced",
		);
	});

	it("leaves the source hash and the classification as they were", () => {
		const captioned = withDiagramCaption(marked, "Delivery plan");

		expect(visualSourceHash(captioned)).toBe(HASH);
		expect(
			visualSourceHash(withDiagramCaption(SOURCE, "Delivery plan")),
		).toBe(visualSourceHash(SOURCE));
		const fence = lines("```mermaid", captioned, "```");
		expect(classifyVisualFences(document(fence), [row()])[0]).toMatchObject(
			{ state: "generated", sourceHash: HASH },
		);
	});

	it("lets preserveVisualMarkers put a dropped marker back when only the caption changed", () => {
		const previous = document(
			lines(
				"```mermaid",
				withDiagramCaption(marked, "Old caption"),
				"```",
			),
		);
		const next = document(
			lines(
				"```mermaid",
				withDiagramCaption(SOURCE, "New caption"),
				"```",
			),
		);

		const result = preserveVisualMarkers(previous, next);
		const [fence] = diagramFences(result);

		expect(fence.value.split("\n").slice(0, 2)).toEqual([
			MARKER,
			"%% caption: New caption",
		]);
		expect(classifyVisualFences(result, [row()])[0].state).toBe(
			"generated",
		);
	});
});

describe("diagram headers", () => {
	it("reads the first line that is neither blank nor a %% comment", () => {
		expect(diagramHeaderLine(bodyOf(FENCE))).toBe("flowchart LR");
		expect(
			diagramHeaderLine(lines("", "%% note", "  graph TD  ", "A")),
		).toBe("graph TD");
		expect(diagramHeaderLine(lines("", "%% only a comment"))).toBeNull();
	});

	it("tells flowcharts apart", () => {
		expect(isFlowchartSource(bodyOf(FENCE))).toBe(true);
		expect(isFlowchartSource(lines("%% drawn by hand", "graph", "A"))).toBe(
			true,
		);
		expect(isFlowchartSource(lines("graph-x", "A --> B"))).toBe(false);
		expect(isFlowchartSource(lines("gantt", "title Plan"))).toBe(false);
		expect(isFlowchartSource("")).toBe(false);
	});
});

describe("visual origins", () => {
	it("names the two origins and guards a stored string", () => {
		expect(VISUAL_ORIGINS).toEqual([
			VISUAL_ORIGIN.STEP,
			VISUAL_ORIGIN.INSTRUCTION,
		]);
		expect(isVisualOrigin("STEP")).toBe(true);
		expect(isVisualOrigin("INSTRUCTION")).toBe(true);
		expect(isVisualOrigin("step")).toBe(false);
	});
});

describe("shared fence helpers", () => {
	it("counts the diagram fences as classifyVisualFences does", () => {
		const markdown = lines(
			"> ```mermaid",
			`> ${bodyOf(FENCE).split("\n").join("\n> ")}`,
			"> ```",
			"",
			"```js",
			"x",
			"```",
			"",
			FENCE,
		);
		expect(diagramFences(markdown).map((fence) => fence.value)).toEqual([
			bodyOf(FENCE),
			bodyOf(FENCE),
		]);
		expect(classifyVisualFences(markdown, [])).toHaveLength(2);
	});

	it("gives the fence body toMermaidFence wraps", () => {
		const source = lines("", "flowchart LR", "  A --> B  ", "");
		expect(toMermaidFenceBody(source, ID)).toBe(
			bodyOf(toMermaidFence(source, ID)),
		);
		expect(toMermaidFenceBody(source)).toBe(bodyOf(toMermaidFence(source)));
	});

	it("mints ids of the marker's shape", () => {
		const id = mintVisualId();
		expect(id).toHaveLength(MINTED_VISUAL_ID_LENGTH);
		expect(isVisualId(id)).toBe(true);
	});
});

describe("diagramSectionFingerprint", () => {
	const flow = [
		"```mermaid",
		`%% fabric-visual: ${ID}`,
		"flowchart LR",
		"  a --> b",
		"```",
	];
	const doc = lines(
		"# Example Proposal",
		"",
		"Preamble text.",
		"",
		"## Approach",
		"",
		"First comes **discovery**, then the build in Q3 2026.",
		"",
		"* Kickoff",
		"* Handover",
		"",
		...flow,
		"",
		"## Plan",
		"",
		"The plan section.",
		"",
		"```mermaid",
		"flowchart TD",
		"  x --> y",
		"```",
	);

	it("names the section around the diagram, heading to next heading", () => {
		expect(diagramSectionAt(doc, 0)).toEqual({
			heading: "Approach",
			markdown: lines(
				"First comes **discovery**, then the build in Q3 2026.",
				"",
				"* Kickoff",
				"* Handover",
				"",
				...flow,
			),
		});
		expect(diagramSectionAt(doc, 1)?.heading).toBe("Plan");
	});

	it("is a v1 hash, and null for an ordinal past the last diagram", () => {
		expect(diagramSectionFingerprint(doc, 0)).toMatch(VISUAL_HASH_PATTERN);
		expect(diagramSectionFingerprint(doc, 0)?.startsWith("v1:")).toBe(true);
		expect(diagramSectionFingerprint(doc, 2)).toBeNull();
		expect(diagramSectionFingerprint("No diagrams here.", 0)).toBeNull();
	});

	it("does not change when the same prose is written again another way", () => {
		const rewritten = lines(
			"# Example Proposal",
			"",
			"Preamble text.",
			"",
			"## Approach",
			"",
			"First comes __discovery__,",
			"then the build   in Q3 2026.   ",
			"",
			"- Kickoff",
			"- Handover",
			"",
			"",
			...flow,
			"",
			"## Plan",
			"",
			"The plan section.",
		).replace(/\n/g, "\r\n");
		expect(diagramSectionFingerprint(rewritten, 0)).toBe(
			diagramSectionFingerprint(doc, 0),
		);
	});

	it("changes when the section's prose or heading changes", () => {
		const base = diagramSectionFingerprint(doc, 0);
		expect(
			diagramSectionFingerprint(doc.replace("Q3 2026", "Q4 2026"), 0),
		).not.toBe(base);
		expect(
			diagramSectionFingerprint(
				doc.replace("* Handover", "* Handover\n* Support"),
				0,
			),
		).not.toBe(base);
		expect(
			diagramSectionFingerprint(
				doc.replace("## Approach", "## Method"),
				0,
			),
		).not.toBe(base);
	});

	it("ignores prose outside the section", () => {
		expect(
			diagramSectionFingerprint(
				doc.replace("The plan section.", "Another plan."),
				0,
			),
		).toBe(diagramSectionFingerprint(doc, 0));
		expect(
			diagramSectionFingerprint(
				doc.replace("Preamble text.", "Other text."),
				0,
			),
		).toBe(diagramSectionFingerprint(doc, 0));
	});

	it("ignores every diagram fence in the section, and keeps other fences", () => {
		const base = diagramSectionFingerprint(doc, 0);
		expect(
			diagramSectionFingerprint(doc.replace("  a --> b", "  a --> c"), 0),
		).toBe(base);
		const withSecond = doc.replace(
			"* Handover\n",
			lines(
				"* Handover",
				"",
				"```mermaid",
				"flowchart LR",
				"  p --> q",
				"```",
				"",
			),
		);
		expect(diagramSectionFingerprint(withSecond, 1)).toBe(base);
		const withCode = doc.replace(
			"* Handover\n",
			lines("* Handover", "", "```text", "Q1 2027", "```", ""),
		);
		expect(diagramSectionFingerprint(withCode, 0)).not.toBe(base);
	});
});
