/**
 * Skill runtime unit tests.
 *
 * Mocks @repo/database and @repo/storage so the loader's scope filtering,
 * frontmatter handling, cache behavior, and tool wiring can be exercised
 * without hitting Postgres or S3.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/database BEFORE loader import
const mockMemberFindFirst = vi.fn();
const mockSkillFindMany = vi.fn();
const mockSkillFindFirst = vi.fn();
const mockSkillFileFindFirst = vi.fn();

vi.mock("@repo/database", async () => ({
	...(await import("@repo/permissions")),
	skillVisibilityWhere: (await import("../../database/prisma/queries/skills"))
		.skillVisibilityWhere,
	db: {
		member: { findFirst: mockMemberFindFirst },
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
	listAvailableSkillPage,
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
	vi.resetAllMocks();
	mockMemberFindFirst.mockResolvedValue({ role: "member" });
	mockSkillFindFirst.mockResolvedValue(mockedSkill());
	mockSkillFindMany.mockResolvedValue([mockedSkill()]);
	mockSkillFileFindFirst.mockResolvedValue({
		id: "example-file",
		version: 1,
		sha256: hash("old"),
		sizeBytes: 3,
		path: "rubric.md",
		contentType: "text/markdown",
		storageKey: "skills/example/rubric.md",
		skill: { version: 1 },
	});
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

const context = { userId: "example-member", organizationId: "example-org" };
function hash(value: string | Buffer) {
	return createHash("sha256").update(value).digest("hex");
}
function file(data: string | Buffer = "old", contentType = "text/markdown") {
	return {
		id: "example-file",
		version: 1,
		sha256: hash(data),
		sizeBytes: Buffer.byteLength(data),
		path: "rubric.md",
		contentType,
		storageKey: "skills/example/rubric.md",
		skill: { version: 1 },
	};
}

describe("governed skill runtime", () => {
	it("requires an organization and current member before any catalog query", async () => {
		await expect(listAvailableSkills({})).rejects.toThrow(
			"current organization",
		);
		await expect(
			listAvailableSkills({ userId: "example-user" }),
		).rejects.toThrow("current organization");
		mockMemberFindFirst.mockResolvedValue(null);
		await expect(listAvailableSkills(context)).rejects.toThrow(
			"access is unavailable",
		);
		expect(mockSkillFindMany).not.toHaveBeenCalled();
	});
	it("discovers published builtins and discoverable organization skills, including creator-owned skills", async () => {
		mockSkillFindMany.mockResolvedValue([mockedSkill()]);
		const result = await listAvailableSkills(context);
		expect(result[0].slug).toBe("architecture-diagram");
		expect(mockSkillFindMany.mock.calls[0][0].where).toEqual({
			isPublished: true,
			archivedAt: null,
			OR: [
				{ scope: "SYSTEM", userId: null, organizationId: null },
				{
					scope: "ORGANIZATION",
					organizationId: "example-org",
					isDiscoverable: true,
				},
			],
		});
	});
	it("does not cache catalog membership, publication or discovery", async () => {
		mockSkillFindMany
			.mockResolvedValueOnce([mockedSkill()])
			.mockResolvedValueOnce([]);
		expect(await listAvailableSkills(context)).toHaveLength(1);
		expect(await listAvailableSkills(context)).toHaveLength(0);
		expect(mockSkillFindMany).toHaveBeenCalledTimes(2);
	});
	it("withholds an answer if membership is removed during catalog read", async () => {
		mockSkillFindMany.mockResolvedValue([mockedSkill()]);
		mockMemberFindFirst
			.mockResolvedValueOnce({ role: "member" })
			.mockResolvedValueOnce(null);
		await expect(listAvailableSkills(context)).rejects.toThrow(
			"access is unavailable",
		);
	});
	it("loads explicit members-only skills without granting automatic discovery", async () => {
		const bundle = await loadSkillBundle("architecture-diagram", context);
		expect(bundle.skillMd).not.toContain("---");
		expect(bundle.files[0].path).toBe("assets/template.html");
		expect(mockSkillFindFirst.mock.calls[0][0].where.OR).toContainEqual({
			scope: "ORGANIZATION",
			organizationId: "example-org",
			archivedAt: null,
			OR: [
				{ userId: "example-member" },
				{ isPublished: true, archivedAt: null },
			],
		});
	});
	it("rechecks publication and the pinned revision after loading instructions", async () => {
		mockSkillFindFirst
			.mockResolvedValueOnce(mockedSkill())
			.mockResolvedValueOnce(null);
		await expect(
			loadSkillBundle("architecture-diagram", context),
		).rejects.toThrow("access or its saved revision changed");
	});
	it("does not return cached instructions after unpublication", async () => {
		await loadSkillBundle("architecture-diagram", context);
		mockSkillFindFirst.mockResolvedValueOnce(null);
		await expect(
			loadSkillBundle("architecture-diagram", context),
		).rejects.toThrow("not found");
	});
	it("enforces expected revision at instruction lookup", async () => {
		await loadSkillBundle("architecture-diagram", context, {
			expectedVersion: 3,
		});
		expect(mockSkillFindFirst.mock.calls[0][0].where.version).toBe(3);
	});
	it("returns UTF-8 text and verifies saved byte size and checksum", async () => {
		const data = "<html></html>";
		mockSkillFileFindFirst.mockResolvedValue(file(data, "text/html"));
		mockDownloadFile.mockResolvedValue({
			data: Buffer.from(data),
			contentType: "text/html",
		});
		const result = await readSkillFile("example", "rubric.md", context);
		expect(result.encoding).toBe("utf-8");
		expect(result.data).toBe(data);
	});
	it("returns base64 for binary content", async () => {
		const data = Buffer.from([0x89, 0x50, 0x4e]);
		mockSkillFileFindFirst.mockResolvedValue(file(data, "image/png"));
		mockDownloadFile.mockResolvedValue({ data, contentType: "image/png" });
		const result = await readSkillFile("example", "rubric.md", context);
		expect(result.encoding).toBe("base64");
		expect(result.data).toBe(data.toString("base64"));
	});
	it("rejects corrupted storage bytes", async () => {
		mockDownloadFile.mockResolvedValue({
			data: Buffer.from("new"),
			contentType: "text/markdown",
		});
		await expect(
			readSkillFile("example", "rubric.md", context),
		).rejects.toThrow("does not match");
	});
	it("rejects oversized files before S3 is read", async () => {
		mockSkillFileFindFirst.mockResolvedValue({
			...file(),
			sizeBytes: MAX_SKILL_FILE_READ_BYTES + 1,
		});
		await expect(
			readSkillFile("example", "rubric.md", context),
		).rejects.toThrow("exceeds per-call limit");
		expect(mockDownloadFile).not.toHaveBeenCalled();
	});
	it("rechecks parent publication after storage read and before returning bytes", async () => {
		mockSkillFileFindFirst
			.mockResolvedValueOnce(file())
			.mockResolvedValueOnce(null);
		mockDownloadFile.mockResolvedValue({
			data: Buffer.from("old"),
			contentType: "text/markdown",
		});
		await expect(
			readSkillFile("example", "rubric.md", context),
		).rejects.toThrow("access or its file revision changed");
	});
	it("rechecks source and current member even on byte-cache hits", async () => {
		mockDownloadFile.mockResolvedValue({
			data: Buffer.from("old"),
			contentType: "text/markdown",
		});
		await readSkillFile("example", "rubric.md", context);
		mockSkillFileFindFirst
			.mockResolvedValueOnce(file())
			.mockResolvedValueOnce(null);
		await expect(
			readSkillFile("example", "rubric.md", context),
		).rejects.toThrow("access or its file revision changed");
		expect(mockDownloadFile).toHaveBeenCalledTimes(1);
	});
	it("enforces expected saved skill revision on file lookup", async () => {
		mockDownloadFile.mockResolvedValue({
			data: Buffer.from("old"),
			contentType: "text/markdown",
		});
		await readSkillFile("example", "rubric.md", context, {
			expectedVersion: 1,
		});
		expect(
			mockSkillFileFindFirst.mock.calls[0][0].where.skill,
		).toMatchObject({ version: 1 });
	});
	it("returns bounded metadata-only pages and accurate file manifest truncation", async () => {
		const files = Array.from({ length: 101 }, (_, n) => ({
			path: `file-${n}.md`,
			contentType: "text/markdown",
			sizeBytes: 2,
		}));
		mockSkillFindMany.mockResolvedValue([
			{ slug: "example", name: "Example", version: 1, files },
			{ slug: "next", name: "Next", version: 1, files: [] },
		]);
		const result = await listAvailableSkillPage(context, {
			offset: 2,
			limit: 1,
		});
		expect(result.hasMore).toBe(true);
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0].files).toHaveLength(100);
		expect(result.skills[0].fileManifestComplete).toBe(false);
		expect(mockSkillFindMany.mock.calls[0][0]).toMatchObject({
			skip: 2,
			take: 2,
			select: { slug: true, name: true, version: true },
			where: {
				isPublished: true,
				archivedAt: null,
				OR: [
					{ scope: "SYSTEM", userId: null, organizationId: null },
					{
						scope: "ORGANIZATION",
						organizationId: "example-org",
						isDiscoverable: true,
					},
				],
			},
		});
		expect(
			mockSkillFindMany.mock.calls[0][0].select.content,
		).toBeUndefined();
	});
});

describe("runtime aliases never substitute readable skill bodies", () => {
	it("rejects a discoverable/builtin and members-only duplicate before instructions or files are read", async () => {
		mockSkillFindMany.mockResolvedValue([
			{ id: "example-builtin", version: 1 },
			{ id: "example-members", version: 1 },
		]);
		await expect(loadSkillBundle("example", context)).rejects.toThrow(
			"ambiguous",
		);
		await expect(
			readSkillFile("example", "rubric.md", context),
		).rejects.toThrow("ambiguous");
		expect(mockSkillFindFirst).not.toHaveBeenCalled();
		expect(mockSkillFileFindFirst).not.toHaveBeenCalled();
		expect(mockDownloadFile).not.toHaveBeenCalled();
	});
	it("withholds a body if its alias becomes ambiguous during the read", async () => {
		mockSkillFindMany
			.mockResolvedValueOnce([{ id: "skill_1", version: 1 }])
			.mockResolvedValueOnce([
				{ id: "skill_1", version: 1 },
				{ id: "example-shadow", version: 1 },
			]);
		await expect(
			loadSkillBundle("architecture-diagram", context),
		).rejects.toThrow("ambiguous");
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
