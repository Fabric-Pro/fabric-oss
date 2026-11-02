import { describe, expect, it } from "vitest";
import {
	COVER_LANGUAGE,
	COVER_LIMITS,
	COVER_RULE,
	type CoverParseResult,
	parseCover,
} from "../lib/proposal-artifact/cover-fence";

const lines = (...parts: string[]) => parts.join("\n");

const FULL_COVER = lines(
	"eyebrow: Proposal · Operations board",
	"organization: Example Harbor Co · Logistics division",
	"for: Example Harbor Co",
	"for: 1 Example Quay, Example City",
	"by: Example Delivery Team",
	"by: example.com",
	"version: 12",
);

const FULL_COVER_PARSED = {
	eyebrow: "Proposal · Operations board",
	organization: "Example Harbor Co · Logistics division",
	forLines: ["Example Harbor Co", "1 Example Quay, Example City"],
	byLines: ["Example Delivery Team", "example.com"],
	version: "12",
};

function reasonOf(result: CoverParseResult): string {
	if (result.ok) {
		throw new Error("expected the block to be refused");
	}
	return result.reason;
}

describe("parseCover", () => {
	it("names the fence language", () => {
		expect(COVER_LANGUAGE).toBe("cover");
	});

	it("parses every key, keeping repeated lines in the order written", () => {
		expect(parseCover(FULL_COVER)).toEqual({
			ok: true,
			visualId: null,
			...FULL_COVER_PARSED,
		});
	});

	it("reads the keys in any order", () => {
		const result = parseCover(
			lines(
				"version: 3",
				"by: Example Delivery Team",
				"for: Example Harbor Co",
				"eyebrow: Proposal",
			),
		);

		expect(result).toEqual({
			ok: true,
			visualId: null,
			eyebrow: "Proposal",
			organization: null,
			forLines: ["Example Harbor Co"],
			byLines: ["Example Delivery Team"],
			version: "3",
		});
	});

	it.each([
		[
			"eyebrow",
			"eyebrow: Proposal · Board",
			{ eyebrow: "Proposal · Board" },
		],
		[
			"organization",
			"organization: Example Harbor Co",
			{ organization: "Example Harbor Co" },
		],
		["for", "for: Example Harbor Co", { forLines: ["Example Harbor Co"] }],
		[
			"by",
			"by: Example Delivery Team",
			{ byLines: ["Example Delivery Team"] },
		],
		["version", "version: 2.1", { version: "2.1" }],
	])(
		"parses a block that sets only %s, leaving the rest empty",
		(_key, body, set) => {
			expect(parseCover(body)).toEqual({
				ok: true,
				visualId: null,
				eyebrow: null,
				organization: null,
				forLines: [],
				byLines: [],
				version: null,
				...set,
			});
		},
	);

	it("reads a leading fabric-visual marker as the visual id, not a field", () => {
		const result = parseCover(
			lines("", "%% fabric-visual: a1b2c3d4e5f6", FULL_COVER),
		);

		expect(result).toEqual({
			ok: true,
			visualId: "a1b2c3d4e5f6",
			...FULL_COVER_PARSED,
		});
	});

	it.each(["for", "by"])(
		"accepts three %s lines and refuses a fourth",
		(key) => {
			const three = [1, 2, 3].map((line) => `${key}: Line ${line}`);

			const accepted = parseCover(lines(...three));
			const refused = parseCover(lines(...three, `${key}: Line 4`));

			expect(accepted.ok).toBe(true);
			expect(reasonOf(refused).startsWith(COVER_RULE)).toBe(true);
			expect(reasonOf(refused)).toContain(
				`more than ${COVER_LIMITS.maxPartyLines} ${key} lines (line 4)`,
			);
		},
	);

	it.each(["eyebrow", "organization", "version"])(
		"refuses a second %s line",
		(key) => {
			const result = parseCover(lines(`${key}: One`, `${key}: Two`));

			expect(reasonOf(result)).toBe(
				`${COVER_RULE} This block has more than one ${key} line (line 2).`,
			);
		},
	);

	it.each([
		["eyebrow", COVER_LIMITS.maxEyebrowLength],
		["organization", COVER_LIMITS.maxOrganizationLength],
		["for", COVER_LIMITS.maxPartyLineLength],
		["by", COVER_LIMITS.maxPartyLineLength],
		["version", COVER_LIMITS.maxVersionLength],
	])(
		"accepts a %s value of exactly %i characters and refuses one more",
		(key, max) => {
			const exact = "x".repeat(max);

			expect(parseCover(`${key}: ${exact}`).ok).toBe(true);
			expect(reasonOf(parseCover(`${key}: ${exact}y`))).toBe(
				`${COVER_RULE} The ${key} value on line 1 is longer than ${max} characters.`,
			);
		},
	);

	it("sets the limits the cover is laid out for", () => {
		expect(COVER_LIMITS).toMatchObject({
			maxEyebrowLength: 80,
			maxOrganizationLength: 120,
			maxPartyLines: 3,
			maxVersionLength: 24,
		});
	});

	it("counts characters, not UTF-16 units, toward a limit", () => {
		const emoji = "🚢".repeat(COVER_LIMITS.maxVersionLength);

		expect(parseCover(`version: ${emoji}`).ok).toBe(true);
	});

	it("refuses an unknown key, a key not in lower case among them", () => {
		for (const line of [
			"title: Example proposal",
			"Eyebrow: Proposal",
			"FOR: Example Harbor Co",
			"prepared for: Example Harbor Co",
		]) {
			const result = parseCover(lines("version: 2", line));
			const key = line.slice(0, line.indexOf(":"));

			expect(reasonOf(result)).toBe(
				`${COVER_RULE} Line 2 has the unknown key "${key}".`,
			);
		}
	});

	it("refuses a line without a colon", () => {
		expect(
			reasonOf(parseCover(lines("for: Example Harbor Co", "Board pack"))),
		).toBe(`${COVER_RULE} Line 2 has no "key: value" separator.`);
	});

	it("refuses a key without a value", () => {
		expect(reasonOf(parseCover("version:"))).toBe(
			`${COVER_RULE} Line 1 needs a value after "version:".`,
		);
		expect(parseCover("for:    ").ok).toBe(false);
	});

	it("splits at the first colon, so a value may hold one and the space is optional", () => {
		const result = parseCover(
			lines(
				"by: https://example.com",
				"version:12",
				"eyebrow : Q3: Board",
			),
		);

		expect(result.ok && result.byLines).toEqual(["https://example.com"]);
		expect(result.ok && result.version).toBe("12");
		expect(result.ok && result.eyebrow).toBe("Q3: Board");
	});

	it("trims every value and ignores blank lines", () => {
		const result = parseCover(
			lines("  for :   Example Harbor Co  ", "", "\tby: example.com\t"),
		);

		expect(result.ok && result.forLines).toEqual(["Example Harbor Co"]);
		expect(result.ok && result.byLines).toEqual(["example.com"]);
	});

	it("keeps markup and inline marks as plain text", () => {
		const result = parseCover(
			lines(
				"for: **Example Harbor Co**",
				"by: <b>Example</b> & Co",
				"eyebrow: `Proposal`",
			),
		);

		expect(result.ok && result.forLines).toEqual(["**Example Harbor Co**"]);
		expect(result.ok && result.byLines).toEqual(["<b>Example</b> & Co"]);
		expect(result.ok && result.eyebrow).toBe("`Proposal`");
	});

	it("refuses a block with no field", () => {
		for (const body of ["", "\n  \n", "%% fabric-visual: a1b2c3d4e5f6"]) {
			expect(reasonOf(parseCover(body))).toBe(
				`${COVER_RULE} This block has none.`,
			);
		}
	});

	it("refuses a marker after the first line, and any other %% line", () => {
		expect(
			reasonOf(
				parseCover(
					lines("version: 2", "%% fabric-visual: a1b2c3d4e5f6"),
				),
			),
		).toBe(
			`${COVER_RULE} Only the first line may be the fabric-visual marker (line 2).`,
		);
		expect(parseCover(lines("version: 2", "%% note: draft")).ok).toBe(
			false,
		);
	});

	it("refuses a marker whose id is malformed", () => {
		for (const marker of [
			"%% fabric-visual: A1B2C3D4E5F6",
			"%% fabric-visual: short1",
			"%% fabric-visual:a1b2c3d4e5f6",
			"%% visual: a1b2c3d4e5f6",
		]) {
			expect(reasonOf(parseCover(lines(marker, "version: 2")))).toBe(
				`${COVER_RULE} Line 1 is not a valid fabric-visual marker.`,
			);
		}
	});

	it("parses a CRLF body the same as an LF one", () => {
		const crlf = parseCover(
			lines("%% fabric-visual: a1b2c3d4e5f6", FULL_COVER).replace(
				/\n/g,
				"\r\n",
			),
		);

		expect(crlf).toEqual({
			ok: true,
			visualId: "a1b2c3d4e5f6",
			...FULL_COVER_PARSED,
		});
	});

	it("refuses a huge body before splitting it, and reads one at the cap", () => {
		const padding = (length: number) => " ".repeat(length);
		const atCap = `version: 2\n${padding(COVER_LIMITS.maxBodyLength - 11)}`;

		expect(atCap.length).toBe(COVER_LIMITS.maxBodyLength);
		expect(parseCover(atCap).ok).toBe(true);
		expect(reasonOf(parseCover(`${atCap} `))).toBe(
			`${COVER_RULE} This block is longer than ${COVER_LIMITS.maxBodyLength} characters.`,
		);
	});

	it("keeps every reason on one line", () => {
		const refused = [
			"",
			"Board pack",
			"title: Example",
			"version:",
			lines("version: 2", "version: 3"),
			lines("for: A", "for: B", "for: C", "for: D"),
			`eyebrow: ${"x".repeat(81)}`,
			"%% fabric-visual: BAD",
		];
		for (const body of refused) {
			expect(reasonOf(parseCover(body))).not.toMatch(/[\r\n]/);
		}
	});
});
