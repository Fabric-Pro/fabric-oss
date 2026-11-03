import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText, detectContentType } from "../chunker";
import {
	CHUNKING_THRESHOLD,
	chooseChunkProfile,
	chunkProjectContent,
	DEFAULT_CHUNK_OVERLAP,
	DEFAULT_CHUNK_SIZE,
	detectTextChunkingStrategy,
} from "../content-routing";
import {
	chunkProfileTuningSchema,
	chunkProseByBoundaries,
	isCustomChunking,
} from "../profiles";

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
	mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mockIsFeatureEnabled,
}));

function flags(on: { openapi?: boolean; contentAware?: boolean }) {
	mockIsFeatureEnabled.mockImplementation(async (key: string) => {
		if (key === "OPENAPI_SPEC_CONTEXT") {
			return on.openapi ?? false;
		}
		if (key === "CONTENT_AWARE_CHUNKING") {
			return on.contentAware ?? false;
		}
		return false;
	});
}

const BACKLOG = [
	"# Backlog",
	...Array.from(
		{ length: 80 },
		(_, i) => `- EX-${i + 1} ${"Some backlog item text ".repeat(4)}`,
	),
].join("\n");

const PRD = [
	"# Product",
	"Intro. ".repeat(300),
	"## Goals",
	"Goal text. ".repeat(300),
	"## Scope",
	"Scope text. ".repeat(300),
].join("\n");

const SHORT = "A short note.";

/**
 * `detectContentType` tests a module-level `/gm` regex, so its answer for the
 * same text alternates with `lastIndex` (a pre-existing quirk of `chunker.ts`).
 * A test on text with no heading resets it, so both sides of a comparison
 * start from the same state.
 */
function resetChunkerState() {
	detectContentType("no heading");
}

/** Today's text-route behaviour, written out independently of the router. */
function todaysChunks(
	content: string,
	mimeType: string,
	filename: string,
	opts: {
		chunkSize?: number;
		chunkOverlap?: number;
		strategy?: "DOCUMENT" | "PARAGRAPH" | "RECURSIVE";
	} = {},
) {
	resetChunkerState();
	if (content.length <= CHUNKING_THRESHOLD) {
		return [
			{
				content,
				index: 0,
				metadata: {
					filename,
					startOffset: 0,
					endOffset: content.length,
				},
			},
		];
	}
	return chunkText(content, filename, {
		strategy: opts.strategy ?? detectTextChunkingStrategy(mimeType),
		chunkSize: opts.chunkSize ?? DEFAULT_CHUNK_SIZE,
		chunkOverlap: opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
	});
}

const CASES: Array<[string, string, string]> = [
	[BACKLOG, "text/markdown", "backlog.md"],
	[PRD, "text/markdown", "prd.md"],
	[SHORT, "text/plain", "note.txt"],
	["a,b\n1,2\n".repeat(400), "text/csv", "data.csv"],
	["plain prose. ".repeat(900), "application/pdf", "doc.pdf"],
];

describe("chunkProjectContent — today's behaviour is preserved", () => {
	beforeEach(() => mockIsFeatureEnabled.mockReset());

	it.each(CASES)(
		"flag off: byte-identical chunks and empty payloads (%#)",
		async (content, mimeType, filename) => {
			flags({ contentAware: false });
			resetChunkerState();
			const result = await chunkProjectContent({
				content,
				mimeType,
				filename,
				chunkByContentType: true,
				kind: "backlog",
			});
			expect(JSON.parse(JSON.stringify(result.chunks))).toEqual(
				JSON.parse(
					JSON.stringify(todaysChunks(content, mimeType, filename)),
				),
			);
			expect(
				result.chunkPayloads.every((p) => Object.keys(p).length === 0),
			).toBe(true);
			expect(result.profile).toBe("prose");
			expect(result.reason).toBe("fallback");
		},
	);

	it.each(CASES)(
		"flag on, project toggle off: byte-identical and the flag is never read (%#)",
		async (content, mimeType, filename) => {
			flags({ contentAware: true });
			resetChunkerState();
			const result = await chunkProjectContent({
				content,
				mimeType,
				filename,
				chunkByContentType: false,
				kind: "backlog",
				profileOverride: "items",
				chunkSize: 3000,
				chunkOverlap: 500,
				textStrategy: "DOCUMENT",
			});
			expect(JSON.stringify(result.chunks)).toBe(
				JSON.stringify(
					todaysChunks(content, mimeType, filename, {
						chunkSize: 3000,
						chunkOverlap: 500,
						strategy: "DOCUMENT",
					}),
				),
			);
			expect(
				result.chunkPayloads.every((p) => Object.keys(p).length === 0),
			).toBe(true);
			expect(mockIsFeatureEnabled).not.toHaveBeenCalledWith(
				"CONTENT_AWARE_CHUNKING",
				expect.anything(),
			);
			expect(
				mockIsFeatureEnabled.mock.calls.some(
					(call) => call[0] === "CONTENT_AWARE_CHUNKING",
				),
			).toBe(false);
		},
	);

	it("leaves OpenAPI payloads untouched when off", async () => {
		flags({ openapi: true, contentAware: true });
		const spec = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: { "/a": { get: { operationId: "getA", responses: {} } } },
		});
		const result = await chunkProjectContent({
			content: spec,
			mimeType: "application/json",
			filename: "a.json",
		});
		expect(result.route.kind).toBe("openapi");
		for (const payload of result.chunkPayloads) {
			expect(payload).not.toHaveProperty("profile");
		}
	});
});

describe("chunkProjectContent — content-aware", () => {
	beforeEach(() => {
		mockIsFeatureEnabled.mockReset();
		flags({ contentAware: true });
	});

	it("passes the organization to the flag", async () => {
		await chunkProjectContent({
			content: SHORT,
			mimeType: "text/plain",
			filename: "a.txt",
			chunkByContentType: true,
			organizationId: "org-example",
		});
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"CONTENT_AWARE_CHUNKING",
			"org-example",
		);
	});

	it("chunks a backlog by item and stamps profile, reason and item key", async () => {
		const result = await chunkProjectContent({
			content: BACKLOG,
			mimeType: "text/markdown",
			filename: "backlog.md",
			chunkByContentType: true,
			kind: "backlog",
		});
		expect(result.profile).toBe("items");
		expect(result.reason).toBe("kind");
		expect(result.chunkPayloads[0]).toMatchObject({
			profile: "items",
			profileReason: "kind",
			itemKey: "EX-1",
			section: "Backlog",
		});
		for (const chunk of result.chunks) {
			expect(chunk.content).not.toMatch(/Some backlog item\s*$/);
		}
	});

	it("detects when no kind is given", async () => {
		const result = await chunkProjectContent({
			content: PRD,
			mimeType: "text/markdown",
			filename: "prd.md",
			chunkByContentType: true,
		});
		expect(result.profile).toBe("sectioned");
		expect(result.reason).toBe("detected");
	});

	it("falls back to the project's size, cutting prose at boundaries", async () => {
		const prose = "Plain prose. ".repeat(900);
		const result = await chunkProjectContent({
			content: prose,
			mimeType: "text/plain",
			filename: "a.txt",
			chunkByContentType: true,
			chunkSize: 3000,
			chunkOverlap: 500,
		});
		expect(result.profile).toBe("prose");
		expect(result.reason).toBe("fallback");
		expect(result.chunks.map((c) => c.content)).toEqual(
			chunkProseByBoundaries(prose, "a.txt", {
				chunkSize: 3000,
				chunkOverlap: 500,
			}).map((c) => c.content),
		);
		for (const chunk of result.chunks) {
			expect(chunk.content).toMatch(/^Plain prose\./);
		}
		expect(result.chunkPayloads[0]).toEqual({
			profile: "prose",
			profileReason: "fallback",
		});
	});

	it("applies a per-type profile from chunkProfiles", async () => {
		const result = await chunkProjectContent({
			content: PRD,
			mimeType: "text/markdown",
			filename: "prd.md",
			chunkByContentType: true,
			kind: "prd",
			chunkProfiles: { prd: { profile: "prose" } },
		});
		expect(result.profile).toBe("prose");
	});

	describe("per-type rows without the earlier toggle (spec §6)", () => {
		const legacy = (content: string, filename: string) =>
			JSON.stringify(
				todaysChunks(content, "text/markdown", filename, {
					chunkSize: 3000,
					chunkOverlap: 500,
					strategy: "DOCUMENT",
				}),
			);
		const run = (
			content: string,
			filename: string,
			kind: "prd" | "backlog",
			chunkProfiles: Record<string, Record<string, unknown>>,
		) => {
			// The chunker keeps regex state between calls; start each run clean.
			resetChunkerState();
			return chunkProjectContent({
				content,
				mimeType: "text/markdown",
				filename,
				chunkByContentType: false,
				kind,
				chunkSize: 3000,
				chunkOverlap: 500,
				textStrategy: "DOCUMENT",
				chunkProfiles,
			});
		};

		it("a type without a row stays on Standard: today's chunks", async () => {
			flags({ contentAware: true });
			const result = await run(PRD, "prd.md", "prd", {
				backlog: { profile: "items" },
			});
			expect(JSON.stringify(result.chunks)).toBe(legacy(PRD, "prd.md"));
			expect(result.chunkPayloads.every((p) => !("profile" in p))).toBe(
				true,
			);
		});

		it("a Standard row chunks as today; a profile row uses the profile", async () => {
			flags({ contentAware: true });
			const standard = await run(BACKLOG, "b.md", "backlog", {
				backlog: { standard: true },
			});
			expect(JSON.stringify(standard.chunks)).toBe(
				legacy(BACKLOG, "b.md"),
			);
			const items = await run(BACKLOG, "b.md", "backlog", {
				backlog: { profile: "items" },
			});
			expect(items.profile).toBe("items");
		});

		it("with the earlier toggle on, a type without a row keeps Auto", async () => {
			flags({ contentAware: true });
			const result = await chunkProjectContent({
				content: BACKLOG,
				mimeType: "text/markdown",
				filename: "b.md",
				chunkByContentType: true,
				kind: "backlog",
			});
			expect(result.profile).toBe("items");
		});
	});
});

describe("chooseChunkProfile", () => {
	const base = { mimeType: "text/markdown", filename: "x.md" };

	it("override > kind > detection > fallback", () => {
		expect(
			chooseChunkProfile({
				...base,
				content: BACKLOG,
				kind: "prd",
				profileOverride: "whole",
			}),
		).toEqual({ profile: "whole", reason: "override" });
		expect(
			chooseChunkProfile({ ...base, content: BACKLOG, kind: "prd" }),
		).toEqual({ profile: "sectioned", reason: "kind" });
		expect(chooseChunkProfile({ ...base, content: BACKLOG })).toEqual({
			profile: "items",
			reason: "detected",
		});
		expect(
			chooseChunkProfile({
				...base,
				content: "just words",
				kind: "other",
			}),
		).toEqual({ profile: "prose", reason: "fallback" });
	});

	it("chooses whole or sectioned for knowledge by length", () => {
		expect(
			chooseChunkProfile({
				...base,
				content: "x".repeat(100),
				kind: "knowledge",
			}).profile,
		).toBe("whole");
		expect(
			chooseChunkProfile({
				...base,
				content: "x".repeat(7000),
				kind: "knowledge",
			}).profile,
		).toBe("sectioned");
	});
});

describe("Custom per-type chunking", () => {
	beforeEach(() => flags({ contentAware: true }));
	const long = Array.from(
		{ length: 60 },
		(_, i) =>
			`Paragraph ${i} explains one part of the booking flow in plain words.`,
	).join("\n\n");

	it("chunks a Custom type with its own size instead of the project's", async () => {
		const base = {
			content: long,
			mimeType: "text/markdown",
			filename: "notes.md",
			chunkingThreshold: 100,
			chunkSize: 3000,
			chunkOverlap: 0,
			chunkByContentType: true,
			kind: "note" as const,
		};
		const project = await chunkProjectContent({
			...base,
			chunkProfiles: { note: { custom: true } },
		});
		const own = await chunkProjectContent({
			...base,
			chunkProfiles: { note: { custom: true, chunkSize: 600 } },
		});
		expect(own.chunks.length).toBeGreaterThan(project.chunks.length);
	});

	it("still reads a stored Standard row as Custom", () => {
		expect(isCustomChunking({ standard: true }, true)).toBe(true);
		expect(isCustomChunking({ custom: true }, true)).toBe(true);
		expect(isCustomChunking({ profile: "sectioned" }, false)).toBe(false);
	});

	it("rejects an overlap that is not smaller than the type's size", () => {
		expect(
			chunkProfileTuningSchema.safeParse({
				custom: true,
				chunkSize: 600,
				chunkOverlap: 600,
			}).success,
		).toBe(false);
	});
});
