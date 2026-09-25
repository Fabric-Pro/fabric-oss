import { describe, expect, it } from "vitest";
import {
	AZURE_DEVOPS_DESCRIPTION_LIMIT,
	azureDevOpsDescription,
	DESCRIPTION_LIMITS,
	DESCRIPTION_SHORTENED_MARKER,
	fitDescription,
} from "../../src/instruction-pull-requests/description";

/**
 * The body `renderPullRequestText` composes (`@repo/instructions`): the
 * escaped note, a `---` paragraph, then the one-line attribution footer.
 */
const FOOTER = "Opened from Fabric project Example Project by Example Person";
const body = (note: string) =>
	note === "" ? `---\n\n${FOOTER}` : `${note}\n\n---\n\n${FOOTER}`;
const TAIL = `\n\n---\n\n${FOOTER}`;

/** A lone UTF-16 surrogate: a split pair. */
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("provider description limits", () => {
	it("documents each provider's limit, counted in UTF-16 code units", () => {
		expect(DESCRIPTION_LIMITS).toEqual({
			GITHUB: 65_536,
			GITLAB: 1_048_576,
			AZURE_DEVOPS: 4_000,
		});
		expect(AZURE_DEVOPS_DESCRIPTION_LIMIT).toBe(4_000);
	});
});

describe("azureDevOpsDescription", () => {
	it("leaves a body within 4000 characters unchanged", () => {
		const text = body("a".repeat(100));
		expect(azureDevOpsDescription(text)).toBe(text);
	});

	it("leaves a body of exactly 4000 characters unchanged, and shortens one of 4001 to exactly 4000", () => {
		const exact = body("a".repeat(4_000 - TAIL.length));
		expect(exact).toHaveLength(4_000);
		expect(azureDevOpsDescription(exact)).toBe(exact);

		const over = body("a".repeat(4_001 - TAIL.length));
		const fitted = azureDevOpsDescription(over);
		expect(fitted).toHaveLength(4_000);
		expect(fitted.endsWith(`${DESCRIPTION_SHORTENED_MARKER}${TAIL}`)).toBe(
			true,
		);
	});

	it("shortens an ASCII note, keeping its start and the whole footer", () => {
		const note = `start ${"x".repeat(5_000)}`;
		const fitted = azureDevOpsDescription(body(note));
		expect(fitted.length).toBeLessThanOrEqual(4_000);
		expect(fitted.startsWith("start xxx")).toBe(true);
		expect(fitted.endsWith(TAIL)).toBe(true);
		expect(fitted).toContain(DESCRIPTION_SHORTENED_MARKER);
	});

	it("counts characters, not bytes: a 4096-byte note of 3-byte characters fits unchanged", () => {
		const note = "€".repeat(1_365);
		expect(Buffer.byteLength(note)).toBe(4_095);
		const text = body(note);
		expect(azureDevOpsDescription(text)).toBe(text);
	});

	it("never splits a surrogate pair at the cut", () => {
		for (const pad of [0, 1]) {
			const note = `${"a".repeat(pad)}${"😀".repeat(3_000)}`;
			const fitted = azureDevOpsDescription(body(note));
			expect(fitted.length).toBeLessThanOrEqual(4_000);
			expect(LONE_SURROGATE.test(fitted)).toBe(false);
			expect(fitted.endsWith(TAIL)).toBe(true);
		}
	});

	it("keeps multibyte text whole and the footer intact", () => {
		const note = "é日本語".repeat(2_000);
		const fitted = azureDevOpsDescription(body(note));
		expect(fitted.length).toBeLessThanOrEqual(4_000);
		expect(fitted.startsWith("é日本語é")).toBe(true);
		expect(fitted.endsWith(TAIL)).toBe(true);
	});

	it("preserves the footer after the LAST separator when the note has its own", () => {
		const note = `intro\n\n---\n\n${"y".repeat(5_000)}`;
		const fitted = azureDevOpsDescription(body(note));
		expect(fitted.length).toBeLessThanOrEqual(4_000);
		expect(fitted.startsWith("intro\n\n---\n\nyyy")).toBe(true);
		expect(fitted.endsWith(TAIL)).toBe(true);
	});

	it("never leaves a dangling escape before the marker", () => {
		// `escapeMarkdown` doubles a backslash; a cut between the two would
		// leave one that escapes the marker's first character.
		for (const shift of [0, 1]) {
			const note = `${"a".repeat(shift)}${"\\\\".repeat(3_000)}`;
			const fitted = azureDevOpsDescription(body(note));
			const kept = fitted.slice(
				0,
				fitted.indexOf(DESCRIPTION_SHORTENED_MARKER),
			);
			const trailing = /\\*$/.exec(kept)?.[0].length ?? 0;
			expect(trailing % 2).toBe(0);
			expect(fitted.length).toBeLessThanOrEqual(4_000);
		}
	});

	it("is deterministic", () => {
		const text = body("z".repeat(6_000));
		expect(azureDevOpsDescription(text)).toBe(azureDevOpsDescription(text));
	});

	it("fits a body with no separator by keeping its start", () => {
		const fitted = fitDescription("q".repeat(50), 20);
		expect(fitted.length).toBeLessThanOrEqual(20);
		expect(fitted.startsWith("q")).toBe(true);
	});
});
