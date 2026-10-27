import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	read: vi.fn(),
	list: vi.fn(),
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: mocks.list,
	loadSkillBundle: mocks.load,
	readSkillFile: mocks.read,
}));

import { executeSkillToolActivity } from "../src/activities/skill-tool-execution";

const bundle = {
	slug: "example-skill",
	name: "Example",
	description: "Reports.",
	version: 1,
	category: null,
	tags: [],
	files: [],
	skillMd: "First instructions.",
};
const input = {
	toolName: "load_skill" as const,
	args: { slug: "example-skill" },
	userId: "example-user",
	organizationId: "example-org",
	answerSnapshotEnabled: true,
};
beforeEach(() => vi.clearAllMocks());
it("reuses the first loaded body after a live visibility check despite edits", async () => {
	mocks.load.mockResolvedValueOnce(bundle).mockResolvedValue({
		...bundle,
		version: 2,
		skillMd: "Edited instructions.",
	});
	const first = await executeSkillToolActivity(input);
	const later = await executeSkillToolActivity({
		...input,
		cachedResult: first,
	} as never);
	expect(later).toEqual({ kind: "bundle", bundle });
});
it("refuses a retained skill body when access has been revoked", async () => {
	mocks.load.mockImplementation(async (_slug, _ctx, options) => {
		if (options?.fresh) {
			throw new Error("not accessible");
		}
		return bundle;
	});
	await expect(
		executeSkillToolActivity({
			...input,
			cachedResult: { kind: "bundle", bundle },
		} as never),
	).rejects.toThrow("not accessible");
});
it("refuses a retained file when access has been revoked", async () => {
	const file = {
		path: "references/example.md",
		contentType: "text/plain",
		encoding: "utf-8",
		data: "First bytes.",
		sizeBytes: 12,
	};
	mocks.read.mockImplementation(async (_slug, _path, _ctx, options) => {
		if (options?.fresh) {
			throw new Error("not accessible");
		}
		return file;
	});
	await expect(
		executeSkillToolActivity({
			...input,
			toolName: "read_skill_file",
			args: { slug: "example-skill", path: file.path },
			cachedResult: { kind: "file", file },
		} as never),
	).rejects.toThrow("not accessible");
});
