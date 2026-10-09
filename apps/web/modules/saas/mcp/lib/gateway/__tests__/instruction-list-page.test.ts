import { describe, expect, it } from "vitest";
import {
	pageInstructionFiles,
	readInstructionListLimit,
} from "../instruction-list-page";

const files = Array.from({ length: 1000 }, (_, i) => ({
	path: `${i % 2 === 0 ? "docs" : "src"}/f${String(i).padStart(4, "0")}.md`,
	kind: "KNOWLEDGE",
	name: `f${String(i).padStart(4, "0")}.md`,
	description: null,
	size: i,
}));

const HEAD = { generation: 1, commitSha: "a".repeat(40) };

function page(input: {
	binding?: typeof HEAD;
	limit?: number;
	cursor?: string;
	prefix?: string;
	files?: Parameters<typeof pageInstructionFiles>[0]["files"];
}) {
	const result = pageInstructionFiles({
		files: input.files ?? files,
		limit: input.limit ?? 200,
		cursor: input.cursor,
		prefix: input.prefix,
		binding: input.binding ?? HEAD,
	});
	if ("error" in result) {
		throw new Error(result.error);
	}
	return result;
}

describe("pageInstructionFiles", () => {
	it("bounds the first page to the default limit and offers a cursor", () => {
		const first = page({});
		expect(first.files).toHaveLength(200);
		expect(first.page).toMatchObject({ returned: 200, total: 1000 });
		expect(first.page.nextCursor).not.toBeNull();
		expect(first.hint).toContain("800 files follow");
		expect(JSON.stringify(first).length).toBeLessThan(30_000);
	});

	it("walks every file exactly once through the cursor", () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const next = page({ limit: 300, cursor });
			seen.push(...next.files.map((f) => f.path));
			if (next.page.nextCursor === null) {
				break;
			}
			cursor = next.page.nextCursor;
		}
		expect(seen).toHaveLength(1000);
		expect(new Set(seen).size).toBe(1000);
	});

	it("filters by path prefix and omits the hint on the last page", () => {
		const docs = page({ limit: 500, prefix: "docs/" });
		expect(docs.page).toMatchObject({
			total: 500,
			returned: 500,
			nextCursor: null,
		});
		expect(docs.hint).toBeUndefined();
		expect(docs.files.every((f) => f.path.startsWith("docs/"))).toBe(true);
	});

	it("keeps entries compact", () => {
		const compact = page({
			files: [
				{
					path: "a/AGENTS.md",
					kind: "INSTRUCTIONS",
					name: "AGENTS.md",
					description: null,
					size: 3,
				},
				{
					path: "a/s.md",
					kind: "SKILL",
					name: "Deploy",
					description: "x".repeat(400),
					size: 4,
				},
			],
		});
		expect(compact.files[0]).toEqual({
			path: "a/AGENTS.md",
			kind: "INSTRUCTIONS",
			size: 3,
		});
		expect(compact.files[1]?.name).toBe("Deploy");
		expect(compact.files[1]?.description?.length).toBeLessThanOrEqual(161);
	});

	it("rejects a cursor it did not issue", () => {
		const result = pageInstructionFiles({
			files,
			limit: 10,
			cursor: "!!",
			prefix: undefined,
			binding: HEAD,
		});
		expect("error" in result).toBe(true);
	});
});

describe("cursor and prefix", () => {
	it("refuses a cursor used against a different commit instead of skipping files", () => {
		const first = page({});
		const moved = pageInstructionFiles({
			files,
			limit: 200,
			cursor: first.page.nextCursor ?? undefined,
			prefix: undefined,
			binding: { generation: 1, commitSha: "b".repeat(40) },
		});
		expect(moved).toMatchObject({
			error: expect.stringContaining("different commit"),
		});
		expect(first.hint).toContain(HEAD.commitSha);
	});

	it("treats the prefix as whole path segments", () => {
		const tree = [
			"docs",
			"docs/a.md",
			"docs-old/b.md",
			"src/docs/c.md",
		].map((path) => ({ path, kind: "OTHER" }));
		const paths = (prefix: string) =>
			page({ files: tree, prefix }).files.map((f) => f.path);
		expect(paths("docs")).toEqual(["docs", "docs/a.md"]);
		expect(paths("docs/")).toEqual(["docs", "docs/a.md"]);
		expect(paths("\\docs\\")).toEqual(["docs", "docs/a.md"]);
	});
});

describe("cursor and prefix limits", () => {
	it("issues a small cursor even for a 512-CJK-character path, and resumes after it", () => {
		const deep = Array.from({ length: 3 }, (_, i) => ({
			path: `${"漢".repeat(512)}${i}.md`,
			kind: "OTHER",
		}));
		const first = page({ files: deep, limit: 1 });
		expect(first.page.nextCursor?.length).toBeLessThan(200);
		const second = page({
			files: deep,
			limit: 1,
			cursor: first.page.nextCursor ?? undefined,
		});
		expect(second.files[0]?.path).toBe(deep[1]?.path);
	});

	it("refuses a cursor used with a different prefix", () => {
		const first = page({ limit: 5, prefix: "docs" });
		expect(() =>
			page({
				limit: 5,
				prefix: "src",
				cursor: first.page.nextCursor ?? undefined,
			}),
		).toThrow(/different prefix/);
	});

	it("refuses an oversized cursor or prefix instead of trusting the schema", () => {
		const base = { files, limit: 10, binding: HEAD };
		expect(
			pageInstructionFiles({
				...base,
				cursor: "x".repeat(2049),
				prefix: undefined,
			}),
		).toHaveProperty("error");
		expect(
			pageInstructionFiles({
				...base,
				cursor: undefined,
				prefix: "p".repeat(513),
			}),
		).toHaveProperty("error");
	});
});

describe("limit", () => {
	it("validates the limit", () => {
		expect(readInstructionListLimit(undefined)).toEqual({ limit: 200 });
		expect("error" in readInstructionListLimit(0)).toBe(true);
		expect("error" in readInstructionListLimit(501)).toBe(true);
		expect(readInstructionListLimit(50)).toEqual({ limit: 50 });
	});
});
