import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The AI assistant is called "Advisor" (Fizzy #2571, after #2487 and #2040).
 * Its /agents featured card, the register-agent hint, the MCP chat dialog and
 * the orchestrator chat's default name still said "Fabric Loom", and a
 * template in the gallery was "Manager Nexus".
 *
 * Only user-visible copy moves. "Loom" and "Nexus" survive deliberately as
 * structure — `LOOM_AGENT_IDS`, the `"loom-orchestrator"` / `"nexus"` surface
 * literals the workflow gates on, the `agents-featured` onboarding target the
 * Get started tour points at, and the `manager-copilot` template slug that
 * keys existing rows. Those are pinned below against a future tidy-up. So is
 * `DEFAULT_AI_AGENT_NAME = "Nexus"`: it only renders on the legacy Nexus page
 * behind `UNIFIED_AGENT_INTERFACE` off, and stored conversations are parsed
 * against it, so renaming it would misread their history.
 *
 * The scan is scoped to the files this rename touched, per
 * `docs/solutions/conventions/a-destination-rename-moves-the-href-and-strands-the-label.md`:
 * Weave's routing agent is also named "Loom", and a repo-wide ban would trip
 * on it and read like a stranded label.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");
const read = (file: string) =>
	readFileSync(path.resolve(repoRoot, file), "utf8");

/** Comments may still tell history; only code and copy are checked. */
function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\s\/\/\s.*$/gm, "");
}

const RETIRED_NAMES = /\b(Loom|Nexus)\b/;

const ADVISOR_SURFACES = [
	"apps/web/modules/saas/agents/components/UnifiedAgentView.tsx",
	"apps/web/modules/saas/agents/components/RegisterExternalAgent.tsx",
	"apps/web/modules/saas/mcp/components/McpChatDialog.tsx",
	"apps/web/modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx",
	"apps/web/modules/saas/agents/components/AgentChatCopilotKit.tsx",
	"apps/web/modules/saas/agents/components/AgentChatGeneral.tsx",
];

describe("Advisor surfaces no longer use retired names", () => {
	it.each(ADVISOR_SURFACES)("%s has no 'Loom' or 'Nexus' copy", (file) => {
		const hits = withoutComments(read(file))
			.split("\n")
			.filter((line) => RETIRED_NAMES.test(line));

		expect(hits).toEqual([]);
	});

	it("the /agents featured card is Advisor and keeps its tour target", () => {
		const view = read(ADVISOR_SURFACES[0]);

		expect(view).toMatch(
			/data-onboarding-target="agents-featured">\s*<FeaturedAgentCard\s+name="Advisor"/,
		);
		expect(view).toContain(
			'const LOOM_AGENT_IDS = new Set(["fabric-workspace-assistant", "fabric-ai"]);',
		);
	});

	it("the orchestrator chat still reports its surface as loom-orchestrator", () => {
		expect(read(ADVISOR_SURFACES[3])).toContain(
			'surface: "loom-orchestrator",',
		);
	});

	it("the legacy Nexus page keeps the default name stored threads parse against", () => {
		expect(
			read("apps/web/modules/saas/agents/lib/conversation-turns.ts"),
		).toContain('export const DEFAULT_AI_AGENT_NAME = "Nexus";');
	});
});

describe("agent template gallery", () => {
	const seed = read("packages/database/prisma/seed-agent-templates.ts");

	it("no template display name says 'Nexus'", () => {
		const names = [...seed.matchAll(/displayName: "([^"]+)"/g)].map(
			([, name]) => name,
		);

		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => RETIRED_NAMES.test(name))).toEqual([]);
	});

	it("the renamed template keeps the slug existing rows are keyed on", () => {
		expect(seed).toMatch(
			/slug: "manager-copilot",\s*name: "managerCopilot",\s*displayName: "Manager Assistant",/,
		);
	});
});
