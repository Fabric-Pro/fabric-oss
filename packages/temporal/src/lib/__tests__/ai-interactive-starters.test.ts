/**
 * Which code may mark AI work as a member's own interactive work (Fizzy #2939).
 *
 * A workflow started with `planEligible: true` carries the starting member's
 * user id in a Temporal header to every activity and child workflow, and all
 * of their AI steps may then run on that member's own ChatGPT plan. That is
 * meant for work a person started — a chat turn, a document they asked for
 * — and never for work nobody started (scheduled sweeps, ingestion, digests,
 * meeting sync, the automatic follow-ons of a save) nor for the bulk runs a
 * person clicks (a scan, a batch of documents, a project setup, an Atlas
 * analysis): one of those can drain a personal plan's window, so they run on
 * the organization's shared plans as a background job instead (product
 * decision, 2026-10-09).
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
	"apps/web/app/api/agents/a2a/send/route.ts":
		"A2A message a person sends to an agent",
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
	"packages/api/modules/projects/procedures/proposal-artifact/rerun-analysis.ts":
		"Internal Analysis re-run a person starts on one Proposal (Fizzy #2946)",
	"packages/api/modules/projects/procedures/meeting-digest/generate-proposals.ts":
		"Feature proposals a person asks for from one meeting (Fizzy #2770); the automatic scan sets none",
	"packages/api/modules/projects/lib/dispatch-document-generation.ts":
		"Passes the caller's flag through; unset for every other starter",
	// Person-started click actions (Fizzy #2770).
	"packages/api/modules/ai/procedures/generate-title-workflow.ts":
		"Title of a person's own chat",
	"packages/api/modules/ai/procedures/retry-failed-message.ts":
		"A person retries their own failed chat message",
	"packages/api/modules/projects/procedures/backlog/start-analysis.ts":
		"Update with context a person starts",
	"packages/api/modules/projects/procedures/backlog/apply-changes.ts":
		"Backlog changes a person approves",
	"packages/api/modules/projects/procedures/backlog/retry-failed-proposal.ts":
		"A person retries one failed proposal",
	"packages/api/modules/projects/procedures/backlog/retry-all-failed-proposals.ts":
		"A person retries their failed proposals",
	"packages/api/modules/projects/procedures/slack-channel-monitor/approve-pending-proposal.ts":
		"A person approves a Slack monitor proposal; the monitor itself sets none",
	"packages/api/modules/projects/procedures/teams-channel-monitor/approve-pending-proposal.ts":
		"A person approves a Teams monitor proposal; the monitor itself sets none",
	"packages/api/modules/projects/procedures/backlog/generate-recommendations.ts":
		"Roadmap recommendations a person asks for",
	"packages/api/modules/projects/procedures/backlog/start-proposal-draft.ts":
		"Proposal draft a person asks for",
	"packages/api/modules/projects/procedures/backlog/start-scope-intake.ts":
		"Scope intake a person starts on one document",
	"packages/api/modules/projects/procedures/meeting-digest/agenda.ts":
		"Meeting agenda a person generates",
	"packages/api/modules/projects/procedures/meeting-digest/extract-insights.ts":
		"Insights a person opens for one meeting; the automatic scan sets none",
	"packages/api/modules/projects/procedures/stories/classify-tracks.ts":
		"Track classification a person asks for",
	"packages/api/modules/projects/procedures/stories/create-story.ts":
		"Classifies the one story a person just created",
	"packages/api/modules/projects/procedures/stories/convert-kind.ts":
		"Body rewrite after a person converts an item's kind",
	"packages/api/modules/projects/procedures/test-cases/ai-draft-test-cases.ts":
		"The Draft cases button",
	"packages/api/modules/projects/lib/start-test-case-draft.ts":
		"Passes the button's flag through; the automatic Ready-for-Dev run sets none",
	"packages/api/modules/reports/procedures/instances/execute.ts":
		"A person runs a report now; scheduled runs set none",
	"apps/web/modules/saas/mcp/lib/gateway/workflow-ai-routing.ts":
		"A member signed in to the MCP server in the browser starts a browser workflow; keys and tokens set none (Fizzy #2770)",
	// Publishing Suite drafts a person clicks; the input names them
	// `actorUserId`, so each also sets `planUserId` (Fizzy #2770).
	"packages/api/modules/projects/procedures/publishing-suite/blog-post.ts":
		"Blog post draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/case-study.ts":
		"Case study draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/linkedin-post.ts":
		"LinkedIn post draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/newsletter-blurb.ts":
		"Newsletter blurb draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/short-post.ts":
		"Short post draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/stakeholder-email.ts":
		"Stakeholder email draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/webinar-script.ts":
		"Webinar script draft a person generates",
	"packages/api/modules/projects/procedures/publishing-suite/refine-draft.ts":
		"A person refines a draft with an instruction",
	"packages/api/modules/projects/procedures/publishing-suite/planning-analysis.ts":
		"Planning analysis a person generates or starts by selecting a topic",
	"packages/api/modules/newsletter/procedures/sends-send-now.ts":
		"A person presses Send now; scheduled sends set none",
	"packages/api/modules/projects/lib/dispatch-glossy-build.ts":
		"Glossy edition an editor builds",
	"packages/api/modules/projects/procedures/discovery/start-discovery.ts":
		"Discovery run a person starts on one feature",
	"packages/api/modules/projects/procedures/agentic-runs/runs.ts":
		"QA agentic run a person starts over the cases they picked",
	"packages/api/modules/projects/lib/story-automations.ts":
		"Skill automation fired by a story a person moved by hand",
	"packages/api/modules/weave/procedures/start-execution.ts":
		"Weave plan execution a person starts",
	"apps/web/app/api/agents/workflow-templates/stream/route.ts":
		"Deep research a person asks for and watches stream",
	// Plumbing that carries or reads the flag; sets it for no one.
	"apps/web/app/api/ai/keys/exchange/route.ts": "Reads the token claim",
	"packages/ai-token/lib/issuer.ts": "Writes the claim it is given",
	"packages/ai-token/lib/types.ts": "Claim type",
	"packages/ai/lib/dynamic-model-selector.ts": "Routing gate",
	"packages/ai/lib/chatgpt-plan/routing.ts": "Routing gate",
	"packages/ai/lib/chatgpt-plan/plan-spent-response.ts":
		"Asks whether the member's interactive work has a plan left before a chat turn (Fizzy #2770); marks none",
	"packages/ai/lib/chatgpt-plan/pool.ts":
		"Routing gate for shared plans (Fizzy #2770); asks for the member's own work, marks none",
	"packages/temporal/src/lib/ai-interactive-interceptor.ts":
		"Stamps the header for a start whose input sets the flag, naming `userId` or `planUserId`",
	"packages/temporal/src/types.ts": "Workflow input types",
	"packages/temporal/src/workflows/auto-analyze-meeting-transcript.ts":
		"Workflow input type; the run itself sets nothing",
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
	"packages/temporal/src/activities/proposal-artifact/analysis.ts":
		"Passes its input's flag (Fizzy #2801)",
	"packages/temporal/src/activities/proposal-artifact/visuals.ts":
		"Passes its input's flag (Fizzy #2801)",
	"packages/temporal/src/lib/glossy/model.ts":
		"Passes its caller's flag; a Glossy build gets it from its run's header instead",
	"packages/temporal/src/lib/proposal-artifact/types.ts":
		"Workflow and activity input types (Fizzy #2801)",
	"packages/temporal/src/activities/orchestrator/delegation/delegate-to-agent.ts":
		"Claim follows the run's marker",
	"packages/temporal/src/activities/weave/delegate-to-weave-agent.ts":
		"Claim follows the run's marker",
};

/**
 * Bulk runs a person starts: each names its job, which keeps it off the
 * clicker's own plan and on the organization's shared plans (Fizzy #2770).
 */
const BULK_STARTERS: Record<string, string> = {
	"packages/api/modules/projects/procedures/scan/lib/start-scan.ts":
		"security-scan",
	"packages/api/modules/projects/procedures/scan/start-grouping.ts":
		"security-scan",
	"packages/api/modules/projects/procedures/scan/start-review.ts":
		"security-scan",
	"packages/api/modules/projects/procedures/documents/batch-generate.ts":
		"batch-document-generation",
	"packages/api/modules/projects/procedures/start-existing-setup.ts":
		"project-setup",
	"packages/api/modules/projects/procedures/azure-devops/start-code-setup.ts":
		"project-setup",
	"packages/api/modules/atlas/procedures/analyze.ts": "atlas-analysis",
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

describe("bulk runs a person starts", () => {
	it.each(Object.entries(BULK_STARTERS))(
		"%s names its job and never marks the run as the clicker's own",
		(file, jobType) => {
			const source = readFileSync(join(REPO_ROOT, file), "utf8");
			expect(source).not.toContain("planEligible");
			expect(source).toContain(`jobType: "${jobType}"`);
		},
	);
});
