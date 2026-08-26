/**
 * Loom Routing Activity
 *
 * Lightweight LLM call that reviews completed step results and can reassign
 * agents for upcoming steps in the next wave. This gives the orchestrator
 * dynamic routing intelligence similar to opencode-weave's Loom agent.
 *
 * Called between execution waves when the plan's executionMode is "weave".
 */

const WEAVE_AGENTS = [
	"weave_thread",
	"weave_spindle",
	"weave_shuttle",
	"weave_weft",
	"weave_warp",
] as const;
type WeaveAgentId = (typeof WEAVE_AGENTS)[number];

export interface LoomRoutingInput {
	completedSteps: Array<{
		id: string;
		description: string;
		executor: string;
		status: string;
		output?: string;
	}>;
	upcomingSteps: Array<{
		id: string;
		description: string;
		executor: string;
	}>;
	projectContext?: string;
	userId: string;
	organizationId?: string;
}

export interface LoomRoutingResult {
	reassignments: Array<{
		stepId: string;
		newAgent: string;
		reason: string;
	}>;
	skipSteps: string[];
	addSteps: Array<{
		description: string;
		agent: string;
		insertBeforeStepId?: string;
	}>;
	reasoning: string;
}

const LOOM_ROUTING_PROMPT = `You are Loom, a routing coordinator for a multi-agent development system.
You have just received results from completed steps and need to decide if upcoming steps should be adjusted.

Available agents:
- weave_thread: Codebase explorer (read-only, fast analysis)
- weave_spindle: External researcher (web docs, APIs, best practices)
- weave_shuttle: Code implementer (writes code via coding runs)
- weave_weft: Quality reviewer (checks correctness, best practices)
- weave_warp: Security auditor (vulnerability scanning, compliance)

Rules:
1. Only reassign if the completed step results clearly indicate a better agent for the upcoming work
2. Skip steps that are now redundant based on prior results
3. Add steps only if the completed results reveal a gap the plan didn't anticipate
4. Be conservative — the plan was already reviewed and approved by the user
5. Return valid JSON only

Respond with JSON:
{
  "reassignments": [{ "stepId": "...", "newAgent": "weave_...", "reason": "..." }],
  "skipSteps": ["step-id-to-skip"],
  "addSteps": [{ "description": "...", "agent": "weave_...", "insertBeforeStepId": "..." }],
  "reasoning": "Brief explanation of routing decisions"
}

If no changes needed, return empty arrays and reasoning explaining why the plan is on track.`;

export async function loomRoutingActivity(
	input: LoomRoutingInput,
): Promise<LoomRoutingResult> {
	// Skip routing if no upcoming steps or no completed context
	if (input.upcomingSteps.length === 0 || input.completedSteps.length === 0) {
		return {
			reassignments: [],
			skipSteps: [],
			addSteps: [],
			reasoning: "No routing needed — first wave or no upcoming steps.",
		};
	}

	// Skip if only review steps remain (weft/warp) — those shouldn't be reassigned
	const nonReviewSteps = input.upcomingSteps.filter(
		(s) => s.executor !== "weave_weft" && s.executor !== "weave_warp",
	);
	if (nonReviewSteps.length === 0) {
		return {
			reassignments: [],
			skipSteps: [],
			addSteps: [],
			reasoning: "Only review steps remain — no routing changes needed.",
		};
	}

	try {
		const { generateText } = await import("ai");
		const { getAIModel } = await import("@repo/ai");

		const model = await getAIModel(
			{ taskType: "SIMPLE" },
			{ userId: input.userId, organizationId: input.organizationId },
		);

		const completedSummary = input.completedSteps
			.map(
				(s) =>
					`- [${s.executor}] ${s.description}: ${s.status}${s.output ? ` → ${s.output.slice(0, 200)}` : ""}`,
			)
			.join("\n");

		const upcomingSummary = input.upcomingSteps
			.map((s) => `- [${s.executor}] (id: ${s.id}) ${s.description}`)
			.join("\n");

		const result = await generateText({
			model,
			system: LOOM_ROUTING_PROMPT,
			messages: [
				{
					role: "user",
					content: `## Completed Steps\n${completedSummary}\n\n## Upcoming Steps\n${upcomingSummary}${input.projectContext ? `\n\n## Project Context\n${input.projectContext}` : ""}`,
				},
			],
			temperature: 0.1,
			maxOutputTokens: 500,
		});

		const jsonMatch = result.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return {
				reassignments: [],
				skipSteps: [],
				addSteps: [],
				reasoning:
					"Loom returned no structured routing — proceeding with plan as-is.",
			};
		}

		const parsed = JSON.parse(jsonMatch[0]) as LoomRoutingResult;

		// Validate reassignments point to real agents
		const validReassignments = (parsed.reassignments || []).filter(
			(r) =>
				input.upcomingSteps.some((s) => s.id === r.stepId) &&
				WEAVE_AGENTS.includes(r.newAgent as WeaveAgentId),
		);

		// Validate skip steps exist
		const validSkips = (parsed.skipSteps || []).filter((id) =>
			input.upcomingSteps.some((s) => s.id === id),
		);

		// Validate added steps have valid agents, cap at 3
		const validAdds = (parsed.addSteps || [])
			.filter(
				(a) =>
					WEAVE_AGENTS.includes(a.agent as WeaveAgentId) &&
					a.description,
			)
			.slice(0, 3);

		return {
			reassignments: validReassignments,
			skipSteps: validSkips,
			addSteps: validAdds,
			reasoning: parsed.reasoning || "Routing adjustments applied.",
		};
	} catch (error) {
		console.warn(
			"[Loom] Routing LLM call failed — proceeding with plan as-is:",
			error instanceof Error ? error.message : error,
		);
		return {
			reassignments: [],
			skipSteps: [],
			addSteps: [],
			reasoning: `Routing skipped due to error: ${error instanceof Error ? error.message : "unknown"}`,
		};
	}
}
