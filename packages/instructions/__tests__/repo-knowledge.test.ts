import { describe, expect, it } from "vitest";
import {
	classifyRepositoryDocument,
	contextSyncPaths,
	extractBacklogItems,
	extractDecision,
	repositoryDocumentPaths,
	sectionText,
} from "../src/repo-knowledge";

const pad = (text: string) =>
	`${text}\n\n${"Some explanatory prose about the product. ".repeat(10)}`;

describe("repository document classification", () => {
	it("reads text documents anywhere, but not dependencies, licences or AI files", () => {
		expect(
			repositoryDocumentPaths([
				"anywhere/deep/notes.md",
				"README.md",
				"src/app.ts",
				"node_modules/x/README.md",
				"LICENSE.md",
				"CLAUDE.md",
				".claude/skills/a/SKILL.md",
			]),
		).toEqual(["anywhere/deep/notes.md", "README.md"]);
	});

	it.each([
		[
			"release-notes",
			"# Changelog\n## [1.2.0]\n- fix\n## [1.1.0]\n- feature",
		],
		[
			"decision",
			"# Use Postgres\n## Status\nAccepted\n## Context\nWe need...\n## Decision\nPostgres\n## Consequences\n...",
		],
		[
			"backlog",
			"# Next\n- [ ] booking export\n- [ ] reminders\n- [ ] payments\n- [x] login",
		],
		[
			"document",
			"# Booking PRD\n## Problem\n...\n## Goals\n...\n## Requirements\n...\n## Acceptance criteria\n...",
		],
		[
			"knowledge",
			"# Journal\n## 2026-10-01\nDid things\n## 2026-10-02\nMore things",
		],
		["context", "# How booking works\nCustomers pick a slot and pay."],
	])("classifies a %s by its content", (kind, text) => {
		expect(
			classifyRepositoryDocument({ path: "x/doc.md", text: pad(text) })
				.kind,
		).toBe(kind);
	});

	it("names the document type and the title", () => {
		const doc = classifyRepositoryDocument({
			path: "somewhere/a.md",
			text: pad(
				"# Platform architecture\n## Architecture\n...\n## Components\n...\n## Deployment\n...",
			),
		});
		expect(doc).toMatchObject({
			kind: "document",
			documentType: "ARCHITECTURE",
			title: "Platform architecture",
		});
	});

	it("skips what is too short", () => {
		expect(
			classifyRepositoryDocument({ path: "a.md", text: "# Hi\nshort" })
				.kind,
		).toBe("skip");
	});
});

describe("repository document extraction", () => {
	it("turns open task items into backlog items, bugs under a bugs heading", () => {
		const items = extractBacklogItems({
			path: "notes/queue.md",
			text: "# Queue\n## Next\n- [ ] Booking export — CSV for owners\n- [ ] Reminders\n- [x] Login\n## Bugs\n- [ ] Calendar shows wrong day",
		});
		expect(items).toEqual([
			expect.objectContaining({
				type: "feature",
				title: "Booking export",
			}),
			expect.objectContaining({ type: "feature", title: "Reminders" }),
			expect.objectContaining({
				type: "bug",
				title: "Calendar shows wrong day",
			}),
		]);
	});

	it("reads one story per file, and nothing from a finished one", () => {
		const story = pad(
			"# Book a slot\nAs a customer, I want to book a slot so that I can visit.\n## Acceptance criteria\n- the slot is held",
		);
		expect(
			classifyRepositoryDocument({ path: "a/us-1.md", text: story }).kind,
		).toBe("backlog");
		expect(extractBacklogItems({ path: "a/us-1.md", text: story })).toEqual(
			[
				expect.objectContaining({
					type: "feature",
					title: "Book a slot",
					acceptanceCriteria:
						expect.stringContaining("- the slot is held"),
				}),
			],
		);
		expect(
			extractBacklogItems({
				path: "a/us-2.md",
				text: `Status: Done\n${story}`,
			}),
		).toEqual([]);
	});

	it("reads an ADR's parts", () => {
		expect(
			extractDecision({
				path: "x/0001-use-postgres.md",
				text: "# ADR-001: Use Postgres\n## Status\nAccepted\n## Context\nWe need a store.\n## Decision\nPostgres.\n## Consequences\nOps work.",
			}),
		).toMatchObject({
			title: "Use Postgres",
			contextProblem: "We need a store.",
			decision: "Postgres.",
			rationale: "Ops work.",
			status: "ACCEPTED",
		});
	});

	it("syncs whole folders where it can, leaving the rest out", () => {
		expect(
			contextSyncPaths({
				documents: [
					"ops/a.md",
					"ops/b.md",
					"ops/c.md",
					"ops/d.md",
					"prd.md",
					"x/one.md",
					"x/two.md",
					"x/three.md",
				],
				chosen: ["ops/a.md", "ops/b.md", "ops/c.md", "x/one.md"],
				limit: 200,
			}),
		).toEqual({ paths: ["ops", "x/one.md"], excludedPaths: ["ops/d.md"] });
	});
});

describe("work items and plans, by content", () => {
	it("reads one item per file when the title carries an id, finished or open", () => {
		const open = pad(
			"# BUG-2026-07-06-01 — Calendar shows the wrong day\n**Status:** open\n## Steps to reproduce\n- [ ] open the calendar\n- [ ] pick a day\n- [ ] see the wrong one",
		);
		expect(
			classifyRepositoryDocument({ path: "x/a.md", text: open }).kind,
		).toBe("backlog");
		expect(extractBacklogItems({ path: "x/a.md", text: open })).toEqual([
			expect.objectContaining({ type: "bug" }),
		]);
		for (const status of [
			"**Status:** **CLOSED — deployed in 1.74.0**",
			"**Status:** ✅ RESOLVED — shipped 1.53.0",
			"- **Статус:** closed (2026-07-06)",
			"> **Closed 2026-10-20 — FIXED.**",
		]) {
			expect(
				classifyRepositoryDocument({
					path: "x/b.md",
					text: pad(
						`# US-1.3 — Phone login\n${status}\n## Acceptance criteria\n- [ ] a\n- [ ] b\n- [ ] c`,
					),
				}).kind,
			).toBe("context");
		}
	});

	it("keeps a plan with steps as knowledge, and a flat task list as backlog", () => {
		expect(
			classifyRepositoryDocument({
				path: "x/p.md",
				text: pad(
					"# Plan — Payments\n## Slice 1\n- [ ] grain\n- [ ] endpoint\n## Slice 2\n- [ ] ui",
				),
			}).kind,
		).toBe("knowledge");
		expect(
			classifyRepositoryDocument({
				path: "x/q.md",
				text: pad(
					"# Queue\n- [ ] export\n- [ ] reminders\n- [ ] payments",
				),
			}).kind,
		).toBe("backlog");
	});
});

describe("files that are not documents", () => {
	it("skips a UTF-16 or binary file and captured program output", () => {
		const utf16 = Buffer.from(
			pad("# Run log\nRunning 86 tests"),
			"utf16le",
		).toString("utf8");
		expect(
			classifyRepositoryDocument({ path: "e2e/run.txt", text: utf16 }),
		).toMatchObject({
			kind: "skip",
			reason: "Not a UTF-8 text file.",
		});
		const ansi = pad(
			`# Output\n${"\u001b[32m✓\u001b[39m passed\n".repeat(6)}`,
		);
		expect(
			classifyRepositoryDocument({ path: "e2e/out.txt", text: ansi })
				.kind,
		).toBe("skip");
	});
});

it("handles long whitespace in repository documents promptly", () => {
	const start = performance.now();
	for (const prefix of ["title:", "#\t", "*\t[ ]\t", ""]) {
		const text = `${prefix + "\t".repeat(50000)}\r`;
		classifyRepositoryDocument({ path: "notes.md", text });
		extractBacklogItems({ path: "notes.md", text });
	}
	expect(performance.now() - start).toBeLessThan(500);
});

function promptly(run: () => unknown): void {
	const start = performance.now();
	run();
	expect(performance.now() - start).toBeLessThan(500);
}
// U+2028 is also a line end for `^` under the m flag, so attack both.
const newlineAttack = `${"\n".repeat(50000)}${"\u2028".repeat(50000)}x`;
const tabAttack = `${"\t".repeat(50000)}\r`;
it("reaches frontmatter title matcher", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: `---\ntitle:${"\n".repeat(50000)}\n---\n${pad("Body")}`,
		});
	}));
it("reaches title and heading collection matchers", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: pad(`#${"\n".repeat(50000)}x`),
		});
	}));
it("bounds classification task counter", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: pad(newlineAttack),
		});
	}));
it("bounds section heading matcher", () =>
	promptly(() => {
		expect(sectionText(`# ${tabAttack}`, "context")).toBeNull();
	}));
it("bounds backlog task collection", () =>
	promptly(() => {
		extractBacklogItems({ path: "notes.md", text: pad(newlineAttack) });
	}));
it("bounds backlog branch heading matcher", () =>
	promptly(() => {
		const tasks = "- [ ] First task\n- [ ] Second task\n- [ ] Third task";
		expect(
			extractBacklogItems({
				path: "notes.md",
				text: `${tasks}\n# ${tabAttack}`,
			}),
		).toHaveLength(3);
	}));
it("bounds backlog branch task matcher", () =>
	promptly(() => {
		const tasks = "- [ ] First task\n- [ ] Second task\n- [ ] Third task";
		expect(
			extractBacklogItems({
				path: "notes.md",
				text: `${tasks}\n- [ ] ${tabAttack}`,
			}),
		).toHaveLength(3);
	}));
it("reaches backlog description heading removal", () =>
	promptly(() => {
		extractBacklogItems({
			path: "US-1.md",
			text: pad(`#${"\n".repeat(50000)}x`),
		});
	}));
it("bounds memory-file detection", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: `---\n${newlineAttack}\n---\n${pad("Body")}`,
		});
	}));
it("bounds plan fence detection", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: `# Work\n- [ ] First\n- [ ] Second\n- [ ] Third\n${newlineAttack}`,
		});
	}));
it("bounds decision status detection", () =>
	promptly(() => {
		expect(
			extractDecision({
				path: "adr-1.md",
				text: `# Example\n## Decision\nUse it.\n${newlineAttack}`,
			}),
		).not.toBeNull();
	}));
it("bounds frontmatter finished-state detection", () =>
	promptly(() => {
		expect(
			extractBacklogItems({
				path: "US-1.md",
				text: `---\n${newlineAttack}\n---\nBody`,
			}),
		).toHaveLength(1);
	}));

it("bounds dated heading counter", () =>
	promptly(() => {
		classifyRepositoryDocument({
			path: "notes.md",
			text: pad(`# ${tabAttack}`),
		});
	}));

it("preserves indented metadata and finished notes", () => {
	expect(
		classifyRepositoryDocument({
			path: "notes.md",
			text: `---\n\ttype: user\n---\n${pad("Body")}`,
		}),
	).toMatchObject({ kind: "skip" });
	for (const note of ["\t**Status:** Done", "\t> done"]) {
		expect(
			extractBacklogItems({
				path: "US-1.md",
				text: `# US-1 Example\n${note}`,
			}),
		).toEqual([]);
	}
	expect(
		extractDecision({
			path: "adr-1.md",
			text: "# Example\n\tstatus: accepted\n## Decision\nUse it.",
		}),
	).toMatchObject({ status: "ACCEPTED" });
});
