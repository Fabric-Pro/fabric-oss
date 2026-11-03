import { describe, expect, it } from "vitest";
import {
	boundaryOverlap,
	chunkProseByBoundaries,
	chunkWithProfile,
	detectProfile,
	parseChunkProfilesConfig,
	profileForKind,
	splitToMax,
} from "../profiles";
import { classifyBoundary } from "../quality";

const md = (lines: string[]) => lines.join("\n");

function detect(
	content: string,
	mimeType = "text/markdown",
	filename = "a.md",
) {
	return detectProfile({ content, mimeType, filename });
}

describe("detectProfile", () => {
	it("detects CSV by MIME and filename", () => {
		expect(detect("a,b\n1,2", "text/csv", "x.csv")).toBe("tabular");
		expect(detect("a,b\n1,2", "text/plain", "x.tsv")).toBe("tabular");
	});

	it("detects tab-separated pasted tables", () => {
		const rows = ["id\tname", "1\tone", "2\ttwo", "3\tthree", "4\tfour"];
		expect(detect(rows.join("\n"), "text/plain", "x.txt")).toBe("tabular");
	});

	it("detects a transcript from speaker lines", () => {
		const transcript = md([
			"Alex: Morning, shall we start?",
			"Sam: Yes, the build is green.",
			"Alex: Good. What about the release?",
			"[00:01:12] Sam: Friday, if QA signs off.",
			"Alex: Fine.",
			"Sam: I will send the notes.",
		]);
		expect(detect(transcript)).toBe("dialogue");
	});

	it("detects dated and versioned entries", () => {
		const journal = md([
			"# Journal",
			"## 2026-01-04",
			"Did things.",
			"## 2026-01-05",
			"More.",
			"## 2026-01-06",
			"Even more.",
		]);
		expect(detect(journal)).toBe("dated");
		const changelog = md([
			"## v1.2.0",
			"- a",
			"## v1.1.0",
			"- b",
			"## 1.0.0",
			"- c",
		]);
		expect(detect(changelog)).toBe("dated");
	});

	it("detects list-heavy content", () => {
		const backlog = md([
			"# Backlog",
			"- EX-1 Login page",
			"- EX-2 Logout",
			"- EX-3 Reset password",
			"- EX-4 Profile",
			"- EX-5 Settings",
		]);
		expect(detect(backlog)).toBe("items");
	});

	it("detects markdown with headings as sectioned", () => {
		const doc = md([
			"# Title",
			"Intro paragraph that is long enough.",
			"## Goals",
			"Some goals.",
		]);
		expect(detect(doc)).toBe("sectioned");
	});

	it("leaves ambiguous prose undetected", () => {
		expect(
			detect(
				"Just a paragraph of prose.\n\nAnd another one, with a 2026-01-01 date inline.",
				"text/plain",
				"a.txt",
			),
		).toBeNull();
	});

	it("ignores headings inside fenced code", () => {
		const doc = md([
			"```",
			"# not a heading",
			"## nor this",
			"```",
			"text",
		]);
		expect(detect(doc)).toBeNull();
	});
});

describe("profileForKind", () => {
	it("maps known kinds", () => {
		expect(profileForKind("prd", 100)).toBe("sectioned");
		expect(profileForKind("adr", 100)).toBe("whole");
		expect(profileForKind("backlog", 100)).toBe("items");
		expect(profileForKind("release-notes", 100)).toBe("dated");
		expect(profileForKind("transcript", 100)).toBe("dialogue");
		expect(profileForKind("csv", 100)).toBe("tabular");
		expect(profileForKind("other", 100)).toBeNull();
	});

	it("uses whole for short knowledge entries and sectioned for long ones", () => {
		expect(profileForKind("knowledge", 6000)).toBe("whole");
		expect(profileForKind("knowledge", 6001)).toBe("sectioned");
	});
});

describe("sectioned", () => {
	it("splits on H1–H3 and prefixes the ancestor heading path", () => {
		const body = "x".repeat(1500);
		const doc = md([
			"# Spec",
			body,
			"## Goals",
			body,
			"### Non-goals",
			body,
		]);
		const chunks = chunkWithProfile(doc, "spec.md", "sectioned");
		expect(chunks).toHaveLength(3);
		expect(chunks[0]?.chunk.content.startsWith("# Spec")).toBe(true);
		expect(chunks[1]?.chunk.content.startsWith("Spec\n\n## Goals")).toBe(
			true,
		);
		expect(
			chunks[2]?.chunk.content.startsWith(
				"Spec > Goals\n\n### Non-goals",
			),
		).toBe(true);
		expect(chunks[2]?.payload.section).toBe("Spec > Goals > Non-goals");
	});

	it("merges small neighbouring sections up to the target", () => {
		const doc = md(["# A", "one", "## B", "two", "## C", "three"]);
		const chunks = chunkWithProfile(doc, "a.md", "sectioned");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.chunk.content).toContain("three");
	});

	it("splits an oversize section and repeats the full path", () => {
		const para = `${"word ".repeat(300).trim()}.`;
		const doc = md([
			"# Big",
			"## Part",
			[para, para, para, para].join("\n\n"),
		]);
		const chunks = chunkWithProfile(doc, "a.md", "sectioned");
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.chunk.content.length).toBeLessThanOrEqual(4000 + 50);
		}
		expect(
			chunks[chunks.length - 1]?.chunk.content.startsWith("Big > Part"),
		).toBe(true);
	});

	it("falls back to paragraphs without headings", () => {
		const para = "p".repeat(1500);
		const chunks = chunkWithProfile(
			[para, para, para].join("\n\n"),
			"a.txt",
			"sectioned",
		);
		expect(chunks).toHaveLength(3);
	});
});

describe("whole", () => {
	it("keeps short content as one chunk", () => {
		const chunks = chunkWithProfile(
			"# ADR 1\n\nDecision.",
			"adr.md",
			"whole",
		);
		expect(chunks).toHaveLength(1);
	});

	it("falls to sectioned above the maximum", () => {
		const big = md(["# A", "a".repeat(3500), "# B", "b".repeat(3500)]);
		const chunks = chunkWithProfile(big, "adr.md", "whole");
		expect(chunks.length).toBe(2);
	});
});

describe("items", () => {
	it("keeps an item with its sub-items and never cuts one in half", () => {
		const items: string[] = ["# Backlog"];
		for (let i = 1; i <= 40; i++) {
			items.push(`- EX-${i} ${"Task description ".repeat(5)}`);
			items.push(`  - sub of ${i}`);
		}
		const chunks = chunkWithProfile(md(items), "backlog.md", "items");
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			// Every "- EX-n" line in a chunk is followed by its own sub-item.
			const ids = [...c.chunk.content.matchAll(/- EX-(\d+) /g)].map(
				(m) => m[1],
			);
			for (const id of ids) {
				expect(c.chunk.content).toContain(`sub of ${id}`);
			}
			expect(c.chunk.content.startsWith("Backlog\n")).toBe(true);
			expect(c.chunk.content.length).toBeLessThanOrEqual(1200 + 20);
		}
		expect(chunks[0]?.payload.itemKey).toBe("EX-1");
	});

	it("repeats a table header for grouped rows", () => {
		const rows = ["| id | title |", "| --- | --- |"];
		for (let i = 1; i <= 60; i++) {
			rows.push(`| ${i} | ${"row text ".repeat(4)}|`);
		}
		const chunks = chunkWithProfile(md(rows), "t.md", "items");
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(
				c.chunk.content.startsWith("| id | title |\n| --- | --- |"),
			).toBe(true);
		}
	});
});

describe("dated", () => {
	it("splits on dated headings and records the date", () => {
		const entry = "e".repeat(2500);
		const doc = md([
			"## 2026-01-04",
			entry,
			"### detail",
			"kept with its day",
			"## 2026-01-05",
			entry,
		]);
		const chunks = chunkWithProfile(doc, "journal.md", "dated");
		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.payload.date).toBe("2026-01-04");
		expect(chunks[0]?.chunk.content).toContain("kept with its day");
		expect(chunks[1]?.payload.date).toBe("2026-01-05");
	});
});

describe("dialogue", () => {
	it("groups turns into windows with one turn of overlap", () => {
		const turns: string[] = [];
		for (let i = 0; i < 30; i++) {
			turns.push(
				`${i % 2 ? "Sam" : "Alex"}: turn ${i} ${"words ".repeat(30)}`,
			);
		}
		const chunks = chunkWithProfile(md(turns), "call.txt", "dialogue");
		expect(chunks.length).toBeGreaterThan(1);
		for (let i = 1; i < chunks.length; i++) {
			const prevLines = chunks[i - 1]?.chunk.content.split("\n") ?? [];
			const lastTurn = prevLines[prevLines.length - 1];
			expect(chunks[i]?.chunk.content.split("\n")[0]).toBe(lastTurn);
		}
		// No turn is ever cut.
		for (const c of chunks) {
			for (const line of c.chunk.content.split("\n")) {
				expect(line).toMatch(/^(Alex|Sam): turn \d+/);
			}
		}
	});
});

describe("tabular", () => {
	it("repeats the header row in every chunk and keeps quoted newlines", () => {
		const rows = ["id,name,notes"];
		for (let i = 1; i <= 200; i++) {
			rows.push(`${i},name ${i},"line one\nline two"`);
		}
		const chunks = chunkWithProfile(md(rows), "data.csv", "tabular");
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.chunk.content.startsWith("id,name,notes\n")).toBe(true);
			expect(c.chunk.content.length).toBeLessThanOrEqual(2000);
			expect((c.chunk.content.match(/"/g) ?? []).length % 2).toBe(0);
		}
	});
});

describe("tuning", () => {
	it("applies a per-type target", () => {
		const items = Array.from(
			{ length: 40 },
			(_, i) => `- item ${i} ${"x".repeat(40)}`,
		);
		const def = chunkWithProfile(md(items), "a.md", "items");
		const tuned = chunkWithProfile(md(items), "a.md", "items", {
			target: 400,
			max: 800,
		});
		expect(tuned.length).toBeGreaterThan(def.length);
	});

	it("drops invalid stored entries", () => {
		const parsed = parseChunkProfilesConfig({
			backlog: { profile: "items", target: 800, max: 1600 },
			prd: { target: 10 },
			nonsense: { target: 1000 },
			adr: { target: 3000, max: 1000 },
		});
		expect(parsed).toEqual({
			backlog: { profile: "items", target: 800, max: 1600 },
		});
	});
});

describe("splitToMax", () => {
	it("never exceeds max and loses no text", () => {
		const text = `${"sentence one. ".repeat(200)}${"z".repeat(5000)}`;
		const pieces = splitToMax(text, 1000);
		for (const p of pieces) {
			expect(p.text.length).toBeLessThanOrEqual(1000);
		}
		expect(pieces.map((p) => p.text).join("")).toBe(text);
	});
});

describe("chunkProseByBoundaries", () => {
	const NL = String.fromCharCode(10);
	const CRLF = String.fromCharCode(13, 10);
	const sentence = (n: number) =>
		`Sentence number ${n} says something about the booking flow.`;
	const paragraph = (from: number) =>
		Array.from({ length: 6 }, (_, i) => sentence(from + i)).join(" ");

	it("cuts between paragraphs and starts each overlap at a sentence", () => {
		const content = Array.from({ length: 12 }, (_, i) =>
			paragraph(i * 6),
		).join(CRLF + CRLF);
		const chunks = chunkProseByBoundaries(content, "a.txt", {
			chunkSize: 1000,
			chunkOverlap: 200,
		});
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(1000 + 200 + 2);
			expect(chunk.content).toMatch(/^Sentence number/);
		}
		for (let i = 0; i + 1 < chunks.length; i++) {
			expect(
				classifyBoundary(
					chunks[i]?.content ?? "",
					chunks[i + 1]?.content ?? "",
				),
			).toBe("clean");
		}
	});

	it("splits an oversized table by rows and repeats its header", () => {
		const header = ["| Key | Text |", "|---|---|"].join(NL);
		const rows = Array.from(
			{ length: 60 },
			(_, i) => `| EX-${i} | row ${i} of the example table |`,
		);
		const content = [header, ...rows].join(NL);
		const chunks = chunkProseByBoundaries(content, "t.md", {
			chunkSize: 600,
			chunkOverlap: 0,
		});
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.content.startsWith(header)).toBe(true);
		}
		const all = chunks.map((c) => c.content).join(NL);
		for (const row of rows) {
			expect(all).toContain(row);
		}
	});

	it("keeps the heading path as the chunk's section", () => {
		const content = [
			"# Guide",
			"## Booking",
			paragraph(0),
			paragraph(6),
		].join(CRLF + CRLF);
		const chunks = chunkProseByBoundaries(content, "g.md", {
			chunkSize: 500,
			chunkOverlap: 0,
		});
		expect(chunks.at(-1)?.metadata.section).toBe("Guide > Booking");
	});
});

describe("boundaryOverlap", () => {
	it("never starts mid-word", () => {
		expect(boundaryOverlap("alpha beta. Gamma delta epsilon", 20)).toBe(
			"Gamma delta epsilon",
		);
		expect(boundaryOverlap("one long run without any boundary", 10)).toBe(
			"",
		);
		const json = ['  "a": 1,', '  "b": 2,'].join(String.fromCharCode(10));
		expect(boundaryOverlap(json, 12)).toBe('"b": 2,');
	});
});
