import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
	resolve(__dirname, "../prisma/schema.prisma"),
	"utf8",
);

function modelBlock(name: string): string {
	const m = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`));
	if (!m) {
		throw new Error(`model ${name} not found`);
	}
	return m[0];
}

describe("StoryAttachment PM-sync fields (Fizzy #1746)", () => {
	const block = modelBlock("StoryAttachment");

	it.each([
		["sourceTool", "String?"],
		["externalAttachmentId", "String?"],
		["contentHash", "String?"],
		["promotedAt", "DateTime?"],
		["externalAuthor", "String?"],
		["externalCreatedAt", "DateTime?"],
	])("declares %s as %s", (field, type) => {
		expect(block).toMatch(
			new RegExp(`\\b${field}\\s+${type.replace("?", "\\?")}`),
		);
	});

	it("declares missingStreak defaulting to 0", () => {
		expect(block).toMatch(/missingStreak\s+Int\s+@default\(0\)/);
	});

	it("does not declare the per-tool external id constraint as a plain @@unique (it is a partial index, in raw SQL)", () => {
		expect(block).not.toMatch(
			/@@unique\(\[storyId, sourceTool, externalAttachmentId\]\)/,
		);
	});

	it("documents the partial unique index that replaces it", () => {
		expect(block).toContain("story_attachment_external_ref_key");
	});

	it("no longer claims attachments are never pushed to a PM tool", () => {
		expect(schema).not.toMatch(/never pushed to a PM tool or an export/);
	});
});

describe("StoryAttachmentSyncIssue (Fizzy #1746)", () => {
	it("exists with the reconcile-issue columns", () => {
		const block = modelBlock("StoryAttachmentSyncIssue");
		for (const field of [
			"storyId",
			"sourceTool",
			"filename",
			"reason",
			"detectedAt",
		]) {
			expect(block).toContain(field);
		}
	});
});

describe("Project.syncAttachments (Fizzy #1746)", () => {
	it("defaults to false", () => {
		expect(modelBlock("Project")).toMatch(
			/syncAttachments\s+Boolean\s+@default\(false\)/,
		);
	});
});
