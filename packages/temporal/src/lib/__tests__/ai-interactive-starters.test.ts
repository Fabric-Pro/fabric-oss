/**
 * Which code may mark AI work as a member's own interactive work (Fizzy #2939).
 *
 * A workflow started with `planEligible: true` carries the starting member's
 * user id in a Temporal header to every activity and child workflow, and all
 * of their AI steps may then run on that member's own ChatGPT plan. That is
 * meant for work a person is waiting on — a chat turn, a document they asked
 * for — and never for bulk work, whose volume would burn through the plan's
 * window: code or repository indexing, RAG and context ingestion, scheduled
 * sweeps, newsletters, digests, meeting sync.
 *
 * This list is the review point. A new file that sets `planEligible` fails
 * here until someone adds it with the reason it is a person's own work.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../../..");

const REVIEWED: Record<string, string> = {
	// Chat routes a person types into.
	"apps/web/app/api/agents/fabric-ai/stream/route.ts": "Direct chat turn",
	"apps/web/app/api/agents/fabric-ai/orchestrator-temporal/route.ts":
		"Orchestrator chat turn",
	"apps/web/app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts":
		"Orchestrator chat turn (the Fabric Agent drawer in Simple mode)",
	"apps/web/app/api/agents/sidekick/stream/route.ts": "Sidekick chat turn",
	"apps/web/app/api/copilotkit/route.ts": "CopilotKit chat and agents",
	"apps/web/app/api/workspaces/chat/route.ts": "Workspace chat turn",
	// One-shot generations a person clicked and waits for.
	"apps/web/app/api/ai/generate/route.ts": "Inline generation",
	"apps/web/app/api/ai/generate-workflow/route.ts": "Workflow draft",
	"apps/web/app/api/ai/generate-prd-from-backlog/route.ts": "PRD draft",
	"packages/api/modules/ai/procedures/add-message-to-chat.ts": "Chat message",
	"packages/api/modules/projects/procedures/stories/enhance-feature.ts":
		"Feature enhancement",
	"packages/api/modules/projects/procedures/create-document.ts":
		"Document a person creates",
	"packages/api/modules/projects/procedures/documents/generate-document.ts":
		"Document a person regenerates",
	"packages/api/modules/projects/lib/dispatch-document-generation.ts":
		"Passes the caller's flag through; unset for every other starter",
	// Plumbing that carries or reads the flag; sets it for no one.
	"apps/web/app/api/ai/keys/exchange/route.ts": "Reads the token claim",
	"packages/ai-token/lib/issuer.ts": "Writes the claim it is given",
	"packages/ai-token/lib/types.ts": "Claim type",
	"packages/ai/lib/dynamic-model-selector.ts": "Routing gate",
	"packages/ai/lib/chatgpt-plan/routing.ts": "Routing gate",
	"packages/ai/lib/chatgpt-plan/pool.ts":
		"Routing gate for shared plans (Fizzy #2770); asks for the member's own work, marks none",
	"packages/temporal/src/lib/ai-interactive-interceptor.ts":
		"Stamps the header for a start whose input sets the flag",
	"packages/temporal/src/types.ts": "Workflow input types",
	"packages/temporal/src/workflows/orchestrator/types/workflow-io.types.ts":
		"Workflow input type",
	"packages/temporal/src/workflows/project-document-generation.ts":
		"Passes its input's flag to its child and activity",
	"packages/temporal/src/workflows/document-generation-child.ts":
		"Passes its input's flag to its activity",
	"packages/temporal/src/workflows/correlation-workflow-interceptor.ts":
		"Forwards the header",
	"packages/temporal/src/worker.ts": "Registers the activity interceptor",
	"packages/temporal/src/activities/direct-chat/ai-execution.ts":
		"Passes its input's flag",
	"packages/temporal/src/activities/project-document-generation.ts":
		"Passes its input's flag",
	"packages/temporal/src/activities/orchestrator/delegation/delegate-to-agent.ts":
		"Claim follows the run's marker",
	"packages/temporal/src/activities/weave/delegate-to-weave-agent.ts":
		"Claim follows the run's marker",
};

const ROOTS = ["apps/web/app", "apps/web/modules", "apps/web/lib", "packages"];
const SKIP_DIRS = new Set([
	"node_modules",
	"__tests__",
	"dist",
	".next",
	".turbo",
	"zod",
	"generated",
]);

function sourceFilesUnder(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) {
			continue;
		}
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			sourceFilesUnder(path, out);
		} else if (
			/\.(ts|tsx)$/.test(name) &&
			!/\.(test|spec)\.tsx?$/.test(name) &&
			!name.endsWith(".d.ts")
		) {
			out.push(path);
		}
	}
}

describe("code that may mark AI work as a member's own", () => {
	it("is only the reviewed list", () => {
		const files: string[] = [];
		for (const root of ROOTS) {
			sourceFilesUnder(join(REPO_ROOT, root), files);
		}
		const marking = files
			.filter((file) =>
				readFileSync(file, "utf8").includes("planEligible"),
			)
			.map((file) => relative(REPO_ROOT, file))
			.sort();
		expect(marking).toEqual(Object.keys(REVIEWED).sort());
	});
});
