/**
 * The "Automations & pages" system skill tells the in-app agent which Fabric
 * tools to call, in what order. It is data (a SKILL.md the seed loads), so
 * nothing else keeps it honest when a tool is renamed or removed: this does.
 * Every named tool must be offered by the gateway. Agent calls require the
 * service credential; page-only calls must stay unavailable to that credential.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-tool-definitions";
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
const PAGE_ONLY_TOOLS: ReadonlySet<string> = new Set(
	FABRIC_PAGE_TOOL_DEFINITIONS.filter(
		(tool) => "pageOnly" in tool && tool.pageOnly,
	).map((tool) => tool.name),
);
// fabric_page_ask is the gateway's sole page-only service exception.
const AGENT_TOOLS = NAMED_TOOLS.filter(
	(name) => !PAGE_ONLY_TOOLS.has(name) || name === "fabric_page_ask",
);

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

	it("names agent tools that the in-app agent's credential can call", () => {
		expect(AGENT_TOOLS).toContain("fabric_page_ask");
		const callable = AGENT_TOOLS.filter((name) => {
			const required = TOOL_SCOPES[name];
			return (
				required &&
				SERVICE_CREDENTIAL_SCOPES.includes(required.scope) &&
				serviceSessionHasTool({}, name)
			);
		});

		expect(callable).toEqual(AGENT_TOOLS);
	});

	it("keeps other named page-only runtime tools unavailable to the agent credential", () => {
		const pageTools = NAMED_TOOLS.filter(
			(name) => PAGE_ONLY_TOOLS.has(name) && name !== "fabric_page_ask",
		);
		expect(pageTools).toEqual(
			expect.arrayContaining([
				"fabric_page_get_workflow",
				"fabric_page_run_workflow",
				"fabric_page_list_workflow_runs",
			]),
		);
		for (const name of pageTools) {
			expect(serviceSessionHasTool({}, name), name).toBe(false);
		}
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
