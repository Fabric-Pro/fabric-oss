/**
 * The "Automations & pages" system skill tells the in-app agent which Fabric
 * tools to call, in what order. It is data (a SKILL.md the seed loads), so
 * nothing else keeps it honest when a tool is renamed or removed: this does.
 * Every `fabric_*` tool the skill names has to be a tool the gateway offers,
 * and the service credential — which is what the in-app agent calls the
 * gateway with — has to be able to call it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));
vi.mock("@repo/database", () => ({ db: {} }));

import { PLATFORM_TOOL_DEFINITIONS, TOOL_SCOPES } from "../platform-tools";
import { serviceSessionHasTool } from "../project-binding";
import { SERVICE_CREDENTIAL_SCOPES } from "../tool-scope";

const SKILL = readFileSync(
	resolve(
		process.cwd(),
		"../../packages/database/prisma/skills-seed/automations-and-pages/SKILL.md",
	),
	"utf8",
);

const NAMED_TOOLS = [
	...new Set(SKILL.match(/\bfabric_[a-z_]+\b/g) ?? []),
].sort();

describe("the Automations & pages skill", () => {
	it("names tools, so the checks below cannot pass on an empty list", () => {
		expect(NAMED_TOOLS.length).toBeGreaterThan(10);
	});

	it("names only tools the gateway offers", () => {
		const offered = new Set(
			PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.name),
		);

		expect(NAMED_TOOLS.filter((name) => !offered.has(name))).toEqual([]);
	});

	it("names only tools the in-app agent's credential can call", () => {
		const callable = NAMED_TOOLS.filter((name) => {
			const required = TOOL_SCOPES[name];
			return (
				required &&
				SERVICE_CREDENTIAL_SCOPES.includes(required.scope) &&
				serviceSessionHasTool({}, name)
			);
		});

		expect(callable).toEqual(NAMED_TOOLS);
	});

	it("carries the frontmatter the seed requires", () => {
		const frontmatter = SKILL.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

		expect(frontmatter).toMatch(/^name: .+/m);
		expect(frontmatter).toMatch(/^description: .+/m);
		expect(frontmatter).toMatch(/^category: .+/m);
	});

	it("describes the three page runtime calls exactly, and declaring the tools a page calls", () => {
		expect(SKILL).toContain("window.fabric.call(toolName, args)");
		expect(SKILL).toContain("window.fabric.openAgent(prompt)");
		expect(SKILL).toContain("window.fabric.navigate(path)");
		expect(SKILL).toContain("runtimeTools");
	});

	it("has the agent make the real call in chat and treats the approval card as the question", () => {
		const section = SKILL.match(/### 2\. [^\n]*\n([\s\S]*?)\n### 3\./)?.[1];

		expect(section).toBeDefined();
		expect(section).toContain(
			"In Fabric's chat the tool takes no `dryRun`",
		);
		expect(section).toContain("Make the real call");
		expect(section).toContain("That card is the question");
		const forChat = section?.split("Only where")[0];
		expect(forChat).not.toMatch(/dryRun: true/);
	});

	it("keeps the dryRun route only for a client whose schema shows it", () => {
		expect(SKILL).toContain(
			"Only where the tool's schema shows `dryRun` (an external client",
		);
	});

	it("tells the agent to give a scheduled task project-context by its capability key", () => {
		expect(SKILL).toContain("`builtInToolNames` takes the capability keys");
		expect(SKILL).toContain("`project-context`");
	});

	it("is a newer version than the one that asked for a dryRun draft first", () => {
		const version = Number(SKILL.match(/^version: (\d+)$/m)?.[1]);

		expect(version).toBeGreaterThanOrEqual(4);
	});

	it("names no real organization, person or hostname", () => {
		expect(SKILL).not.toMatch(/https?:\/\//);
	});
});
