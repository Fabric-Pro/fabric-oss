import { join } from "node:path";
import { seedWorkingDraftIfAbsent } from "@repo/database";
import { logger } from "@repo/logs";
import { beforeEach, expect, it, vi } from "vitest";
import { seedWorkingDraftAfterCommit } from "../seed-working-draft-after-commit";
import { databaseValueImports } from "./_ast-guards";

vi.mock("@repo/database", () => ({ seedWorkingDraftIfAbsent: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const input = {
	topicId: "topic-1",
	projectId: "proj-1",
	sourceDraftId: "draft-1",
	postType: "BLOG_POST" as const,
	body: "Draft",
	updatedById: "user-1",
};
const context = { draftId: "draft-1", topicId: "topic-1", projectId: "proj-1" };
beforeEach(() => vi.resetAllMocks());

it("returns true only for a seeded draft", async () => {
	vi.mocked(seedWorkingDraftIfAbsent).mockResolvedValue({
		status: "seeded",
	} as Awaited<ReturnType<typeof seedWorkingDraftIfAbsent>>);
	await expect(seedWorkingDraftAfterCommit("[test]", input)).resolves.toBe(
		true,
	);
	expect(seedWorkingDraftIfAbsent).toHaveBeenCalledWith(input);
	expect(logger.warn).not.toHaveBeenCalled();
	expect(logger.info).not.toHaveBeenCalled();
	expect(logger.debug).not.toHaveBeenCalled();
});
it.each([
	[
		"already_exists",
		"debug",
		"topic already has a working draft; left untouched",
	],
	[
		"source_not_found",
		"info",
		"draft was superseded before it could seed a working draft",
	],
	[
		"project_ineligible",
		"warn",
		"project became ineligible before the working draft could be seeded",
	],
] as const)("logs %s at %s", async (status, level, message) => {
	vi.mocked(seedWorkingDraftIfAbsent).mockResolvedValue({ status } as Awaited<
		ReturnType<typeof seedWorkingDraftIfAbsent>
	>);
	await expect(seedWorkingDraftAfterCommit("[test]", input)).resolves.toBe(
		false,
	);
	expect(logger[level]).toHaveBeenCalledWith(`[test] ${message}`, context);
});
it.each([new Error("seed failed"), "seed failed"])(
	"resolves false when seeding throws %s",
	async (error) => {
		vi.mocked(seedWorkingDraftIfAbsent).mockRejectedValue(error);
		await expect(
			seedWorkingDraftAfterCommit("[test]", input),
		).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			"[test] failed to seed a working draft",
			{ ...context, error: "seed failed" },
		);
	},
);

it("imports only the create-only database writer", () => {
	expect(
		databaseValueImports(
			join(__dirname, "../seed-working-draft-after-commit.ts"),
		),
	).toEqual(["seedWorkingDraftIfAbsent"]);
});
