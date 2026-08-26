/**
 * Skill runtime unit tests.
 *
 * Mocks @repo/database and @repo/storage so the loader's scope filtering,
 * frontmatter handling, cache behavior, and tool wiring can be exercised
 * without hitting Postgres or S3.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database BEFORE loader import
const mockSkillFindMany = vi.fn();
const mockSkillFindFirst = vi.fn();
const mockSkillFileFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		skill: {
			findMany: mockSkillFindMany,
			findFirst: mockSkillFindFirst,
		},
		skillFile: {
			findFirst: mockSkillFileFindFirst,
		},
	},
}));

const mockDownloadFile = vi.fn();
vi.mock("@repo/storage", () => ({
	downloadFile: mockDownloadFile,
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Fresh import so the mocks are applied
const {
	buildSkillsSystemBlock,
	createSkillTools,
	invalidateSkillCache,
	listAvailableSkills,
	loadSkillBundle,
	MAX_SKILL_FILE_READ_BYTES,
	readSkillFile,
	stripFrontmatter,
} = await import("../skills");

const SAMPLE_SKILL_MD = `---
name: architecture-diagram
description: Create diagrams.
metadata:
  version: "1.0"
---

# Architecture Diagram Skill

Body starts here.
`;

function mockedSkill(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "skill_1",
		slug: "architecture-diagram",
		name: "Architecture Diagram Skill",
		description: "Create diagrams.",
		version: 1,
		category: "visualization",
		tags: ["diagram"],
		content: SAMPLE_SKILL_MD,
		scope: "SYSTEM",
		userId: null,
		organizationId: null,
		isPublished: true,
		files: [
			{
				path: "assets/template.html",
				contentType: "text/html; charset=utf-8",
				sizeBytes: 12483,
			},
		],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	invalidateSkillCache();
});

describe("stripFrontmatter", () => {
	it("removes YAML frontmatter block", () => {
		const result = stripFrontmatter(SAMPLE_SKILL_MD);
		expect(result).not.toContain("---");
		expect(result.trim().startsWith("# Architecture Diagram Skill")).toBe(
			true,
		);
	});

	it("returns input unchanged when no frontmatter", () => {
		const input = "# Hello\n\nNo frontmatter here.";
		expect(stripFrontmatter(input)).toBe(input);
	});
});

describe("listAvailableSkills", () => {
	it("scopes query to SYSTEM for anonymous context", async () => {
		mockSkillFindMany.mockResolvedValueOnce([mockedSkill()]);
		const result = await listAvailableSkills({});

		expect(mockSkillFindMany).toHaveBeenCalledTimes(1);
		const whereArg = mockSkillFindMany.mock.calls[0][0].where;
		expect(whereArg.isPublished).toBe(true);
		expect(whereArg.OR).toHaveLength(1);
		expect(whereArg.OR[0]).toEqual({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
		});

		expect(result).toHaveLength(1);
		expect(result[0].slug).toBe("architecture-diagram");
		expect(result[0].files).toHaveLength(1);
	});

	it("org context admits SYSTEM + ORG only, never USER (strict XOR)", async () => {
		mockSkillFindMany.mockResolvedValueOnce([]);
		await listAvailableSkills({ userId: "u1", organizationId: "o1" });

		const whereArg = mockSkillFindMany.mock.calls[0][0].where;
		expect(whereArg.OR).toHaveLength(2);
		expect(whereArg.OR).toContainEqual({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
		});
		expect(whereArg.OR).toContainEqual({
			scope: "ORGANIZATION",
			organizationId: "o1",
			userId: null,
		});
		// USER-scoped skills must NOT appear in org context — they'd leak
		// personal skills across org members via the org-keyed cache.
		expect(
			(whereArg.OR as Array<Record<string, unknown>>).some(
				(c) => c.scope === "USER",
			),
		).toBe(false);
	});

	it("personal context admits SYSTEM + USER only, never ORG", async () => {
		mockSkillFindMany.mockResolvedValueOnce([]);
		await listAvailableSkills({ userId: "u1" });

		const whereArg = mockSkillFindMany.mock.calls[0][0].where;
		expect(whereArg.OR).toHaveLength(2);
		expect(whereArg.OR).toContainEqual({
			scope: "USER",
			userId: "u1",
			organizationId: null,
		});
	});

	it("caches subsequent calls within TTL", async () => {
		mockSkillFindMany.mockResolvedValueOnce([mockedSkill()]);
		await listAvailableSkills({ userId: "u1" });
		await listAvailableSkills({ userId: "u1" });

		expect(mockSkillFindMany).toHaveBeenCalledTimes(1);
	});
});

describe("loadSkillBundle", () => {
	it("returns SKILL.md with frontmatter stripped + manifest", async () => {
		mockSkillFindFirst.mockResolvedValueOnce(mockedSkill());
		const bundle = await loadSkillBundle("architecture-diagram", {});

		expect(bundle.skillMd).not.toContain("---");
		expect(
			bundle.skillMd.trim().startsWith("# Architecture Diagram Skill"),
		).toBe(true);
		expect(bundle.files[0].path).toBe("assets/template.html");
	});

	it("throws when skill is out of scope", async () => {
		mockSkillFindFirst.mockResolvedValueOnce(null);
		await expect(loadSkillBundle("ghost", {})).rejects.toThrow(
			/not found or not accessible/,
		);
	});
});

describe("readSkillFile", () => {
	it("returns utf-8 text for text content types", async () => {
		mockSkillFileFindFirst.mockResolvedValueOnce({
			id: "file_1",
			skillId: "skill_1",
			path: "assets/template.html",
			contentType: "text/html; charset=utf-8",
			storageKey: "skills/skill_1/file_1/template.html",
			sizeBytes: 20,
			sha256: "abc",
			version: 1,
		});
		mockDownloadFile.mockResolvedValueOnce({
			data: Buffer.from("<html></html>"),
			contentType: "text/html",
			size: 13,
		});

		const out = await readSkillFile(
			"architecture-diagram",
			"assets/template.html",
			{},
		);
		expect(out.encoding).toBe("utf-8");
		expect(out.data).toBe("<html></html>");
	});

	it("base64-encodes non-text content", async () => {
		mockSkillFileFindFirst.mockResolvedValueOnce({
			id: "file_1",
			skillId: "skill_1",
			path: "assets/logo.png",
			contentType: "image/png",
			storageKey: "skills/skill_1/file_1/logo.png",
			sizeBytes: 3,
			sha256: "abc",
			version: 1,
		});
		mockDownloadFile.mockResolvedValueOnce({
			data: Buffer.from([0x89, 0x50, 0x4e]),
			contentType: "image/png",
			size: 3,
		});

		const out = await readSkillFile(
			"architecture-diagram",
			"assets/logo.png",
			{},
		);
		expect(out.encoding).toBe("base64");
		expect(out.data).toBe(
			Buffer.from([0x89, 0x50, 0x4e]).toString("base64"),
		);
	});

	it("rejects files larger than MAX_SKILL_FILE_READ_BYTES", async () => {
		mockSkillFileFindFirst.mockResolvedValueOnce({
			id: "file_1",
			skillId: "skill_1",
			path: "assets/huge.bin",
			contentType: "application/octet-stream",
			storageKey: "skills/skill_1/file_1/huge.bin",
			sizeBytes: MAX_SKILL_FILE_READ_BYTES + 1,
			sha256: "abc",
			version: 1,
		});

		await expect(
			readSkillFile("architecture-diagram", "assets/huge.bin", {}),
		).rejects.toThrow(/exceeds per-call limit/);
	});
});

describe("buildSkillsSystemBlock", () => {
	it("returns null when no skills in scope", () => {
		expect(buildSkillsSystemBlock([])).toBeNull();
	});

	it("formats one-line-per-skill registry", () => {
		const block = buildSkillsSystemBlock([
			{
				slug: "architecture-diagram",
				name: "Architecture Diagram",
				description: "Create diagrams.",
				version: 1,
				category: null,
				tags: [],
				files: [],
			},
		]);
		expect(block).toContain("## Available Skills");
		expect(block).toContain("- architecture-diagram: Create diagrams.");
	});
});

describe("createSkillTools", () => {
	it("exposes list_skills, load_skill, read_skill_file", () => {
		const tools = createSkillTools({});
		expect(Object.keys(tools).sort()).toEqual([
			"list_skills",
			"load_skill",
			"read_skill_file",
		]);
	});
});
