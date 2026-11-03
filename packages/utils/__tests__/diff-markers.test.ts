import { describe, expect, it } from "vitest";
import {
	DIFF_ADD_END,
	DIFF_ADD_START,
	DIFF_DEL_END,
	DIFF_DEL_START,
	resolveEncodedDiffMarkers,
	stripResidualDiffMarkers,
} from "../lib/diff-markers";

// The markers as a link destination carries them once markdown-it has
// percent-encoded the zero-width and non-breaking spaces (Fizzy #2946).
const ENC_DEL_START = "%E2%80%8B%E2%80%8BDEL_START%E2%80%8B%C2%A0";
const ENC_DEL_END = "%C2%A0%E2%80%8BDEL_END%E2%80%8B%E2%80%8B";
const ENC_ADD_START = "%E2%80%8B%E2%80%8BADD_START%E2%80%8B%C2%A0";
const ENC_ADD_END = "%C2%A0%E2%80%8BADD_END%E2%80%8B%E2%80%8B";

describe("stripResidualDiffMarkers: markers percent-encoded into a destination", () => {
	it("keeps the accepted URL: the deleted run goes with its text, the added run stays", () => {
		const saved = `See [the docs](https://example.com/${ENC_DEL_START}old${ENC_DEL_END}${ENC_ADD_START}new${ENC_ADD_END}) here.`;

		expect(stripResidualDiffMarkers(saved)).toBe(
			"See [the docs](https://example.com/new) here.",
		);
	});

	it("reads lowercase hex the same way", () => {
		const lowerHex = (marker: string) =>
			marker.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
		const saved = `[d](https://example.com/${lowerHex(ENC_DEL_START)}old${lowerHex(ENC_DEL_END)}${lowerHex(ENC_ADD_START)}new${lowerHex(ENC_ADD_END)})`;

		expect(stripResidualDiffMarkers(saved)).toBe(
			"[d](https://example.com/new)",
		);
	});

	it("keeps an added run's text and drops a deleted run's text when each stands alone", () => {
		expect(
			stripResidualDiffMarkers(
				`![chart](https://example.com/${ENC_ADD_START}b${ENC_ADD_END}.png)`,
			),
		).toBe("![chart](https://example.com/b.png)");
		expect(
			stripResidualDiffMarkers(
				`[d](https://example.com/guide${ENC_DEL_START}-old${ENC_DEL_END})`,
			),
		).toBe("[d](https://example.com/guide)");
	});

	it("leaves encoded spaces that are not part of a marker alone", () => {
		const saved =
			"[d](https://example.com/a%C2%A0b?q=%E2%80%8B) and [e](https://example.com/%E2%80%8B%E2%80%8BADD)";

		expect(stripResidualDiffMarkers(saved)).toBe(saved);
	});
});

describe("stripResidualDiffMarkers: raw markers and zero-width characters", () => {
	it("removes raw marker tokens, keeping the text between them", () => {
		expect(
			stripResidualDiffMarkers(
				`One ${DIFF_DEL_START}old${DIFF_DEL_END}${DIFF_ADD_START}new${DIFF_ADD_END} two`,
			),
		).toBe("One oldnew two");
	});

	it("removes stray zero-width spaces and byte order marks, not non-breaking spaces", () => {
		expect(stripResidualDiffMarkers("a\u200Bb\uFEFFc\u00A0d")).toBe(
			"abc\u00A0d",
		);
	});
});

describe("stripResidualDiffMarkers: time on hostile input", () => {
	// docs/solutions/security-issues/redos-in-preview-markdown-strip.md: one
	// long line with no whitespace, and a hard time budget. The server runs
	// this on a stored body before any check can refuse it.
	it("stays linear on a single line of unterminated encoded start markers", () => {
		const delStarts = ENC_DEL_START.repeat(12000);
		const addStarts = `${ENC_ADD_START}x`.repeat(12000);

		for (const fixture of [delStarts, addStarts]) {
			expect(fixture).not.toMatch(/\s/);
			const started = performance.now();
			stripResidualDiffMarkers(fixture);
			expect(performance.now() - started).toBeLessThan(200);
		}
	});
});

describe("stripResidualDiffMarkers: a run never leaves its destination", () => {
	it("leaves markers that span two links alone instead of deleting between them", () => {
		const saved = `[one](https://example.com/${ENC_DEL_START}old)[two](https://example.org/${ENC_DEL_END}tail)`;

		// Each marker is left without its pair, so it becomes a hyphen.
		expect(stripResidualDiffMarkers(saved)).toBe(
			"[one](https://example.com/-old)[two](https://example.org/-tail)",
		);
	});
});

describe("resolveEncodedDiffMarkers: one pass leaves nothing for a second", () => {
	// Removing a lone encoded marker used to join the halves around it into
	// a new whole marker, so the review and the save, resolving a different
	// number of times, could store different destinations (Fizzy #2946).
	const ANY_ENCODED_MARKER = new RegExp(
		[DIFF_ADD_START, DIFF_ADD_END, DIFF_DEL_START, DIFF_DEL_END]
			.map(encodeURI)
			.join("|"),
		"i",
	);

	/** `encoded` cut in two, `at` characters into its marker word. */
	const halves = (encoded: string, at: number): [string, string] => {
		const word = encoded.search(/[A-Z]{3}_/);
		return [encoded.slice(0, word + at), encoded.slice(word + at)];
	};

	/** Resolves `input`, checking the result is a fixed point with no marker. */
	const resolveToFixedPoint = (input: string): string => {
		const once = resolveEncodedDiffMarkers(input);
		expect(resolveEncodedDiffMarkers(once)).toBe(once);
		expect(once).not.toMatch(ANY_ENCODED_MARKER);
		return once;
	};

	it("does not join the halves around a lone marker into a new one", () => {
		const input = `https://example.com/%E2%80%8B%E2%80%8BDEL_ST${ENC_ADD_END}ART%E2%80%8B%C2%A0evil${ENC_DEL_END}/a`;

		expect(resolveToFixedPoint(input)).toBe(
			"https://example.com/%E2%80%8B%E2%80%8BDEL_ST-ART%E2%80%8B%C2%A0evil-/a",
		);
	});

	it("resolves a marker split twice over in one pass", () => {
		// Each marker word is split by a lone marker whose own word is split.
		const [addEndHead, addEndTail] = halves(ENC_ADD_END, 5);
		const lone = `${addEndHead}${ENC_ADD_END}${addEndTail}`;
		const split = (encoded: string) => {
			const [head, tail] = halves(encoded, 5);
			return `${head}${lone}${tail}`;
		};
		const input = `https://evil.example${split(ENC_DEL_START)}@trusted.example.com/x${split(ENC_DEL_END)}/pay`;

		const resolved = resolveToFixedPoint(input);
		expect(resolved).toContain("@trusted.example.com/x");
	});

	it("leaves no marker when removing a run joins the halves around it", () => {
		const [head, tail] = halves(ENC_DEL_START, 6);
		const afterDeletedRun = `${head}${ENC_DEL_START}x${ENC_DEL_END}${tail}hidden${ENC_DEL_END}`;
		const afterAddedRun = `${head}${ENC_ADD_START}${ENC_ADD_END}${tail}hidden${ENC_DEL_END}`;

		for (const input of [afterDeletedRun, afterAddedRun]) {
			expect(
				resolveToFixedPoint(`https://example.com/${input}`),
			).toContain("hidden");
		}
	});

	it("resolves markers that share their zero-width spaces", () => {
		// `ADD_END` ends with the two zero-width spaces `DEL_START` begins with.
		const shared = `${ENC_ADD_END}${ENC_DEL_START.replace("%E2%80%8B%E2%80%8B", "")}`;

		expect(resolveToFixedPoint(`https://example.com/${shared}x`)).toBe(
			"https://example.com/-DEL_START%E2%80%8B%C2%A0x",
		);
	});

	it("keeps the run semantics: a deleted run goes, an added run stays", () => {
		const input = `https://example.com/${ENC_DEL_START}a${ENC_ADD_START}b${ENC_ADD_END}c${ENC_DEL_END}${ENC_ADD_START}new${ENC_ADD_END}`;

		expect(resolveToFixedPoint(input)).toBe("https://example.com/new");
	});

	it("is a fixed point after one pass on any mix of markers and their halves", () => {
		const markers = [
			ENC_ADD_START,
			ENC_ADD_END,
			ENC_DEL_START,
			ENC_DEL_END,
		];
		const lowerHex = (marker: string) =>
			marker.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
		const pieces = [
			"a",
			...markers,
			lowerHex(ENC_DEL_START),
			...markers.flatMap((marker) => [
				...halves(marker, 0),
				...halves(marker, 4),
				...halves(marker, 7),
			]),
		];
		// A fixed linear congruential sequence keeps the cases reproducible.
		let seed = 2946;
		const next = (bound: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % bound;
		};

		for (let round = 0; round < 3000; round++) {
			const length = 1 + next(9);
			let input = "";
			for (let index = 0; index < length; index++) {
				input += pieces[next(pieces.length)];
			}
			const once = resolveEncodedDiffMarkers(input);
			expect(resolveEncodedDiffMarkers(once), input).toBe(once);
			expect(once, input).not.toMatch(ANY_ENCODED_MARKER);
		}
	});
});
