import { createHash } from "node:crypto";
import { AI_CALL_PURPOSES } from "@repo/ai/lib/call-purpose";
import {
	buildSkillsSystemBlock,
	createSkillTools,
	listAvailableSkills,
} from "@repo/ai/skills";
import { z } from "zod";
import type { AdvisorAnswerSnapshot } from "../../../workflows/orchestrator/advisor-answer-snapshot";
import { usageOriginFields } from "../../../workflows/orchestrator/usage-attribution";
import { getAiModelWithSelection } from "../utils";
import type { RunAgentIterationInput } from "./run-agent-iteration";

/** Leaves room for the route within the activity payload; skill bodies load on demand. */
const MAX_SKILLS_SNAPSHOT_BYTES = 192 * 1024;
export async function snapshotAdvisorAnswerActivity(
	input: Pick<
		RunAgentIterationInput,
		| "userId"
		| "organizationId"
		| "executionId"
		| "conversationId"
		| "projectId"
		| "frameId"
		| "modelOverride"
		| "turnScope"
	> & { hasTools?: boolean },
): Promise<{ snapshot?: AdvisorAnswerSnapshot }> {
	let skills: AdvisorAnswerSnapshot["skills"];
	try {
		const available = await listAvailableSkills({
			userId: input.userId,
			organizationId: input.organizationId,
		});
		const tools = available.length
			? Object.fromEntries(
					Object.entries(
						createSkillTools({}, { withExecute: false }),
					).map(([name, definition]) => [
						name,
						{
							description: definition.description ?? "",
							inputSchema: z.toJSONSchema(
								definition.inputSchema as z.ZodType,
							) as Record<string, unknown>,
						},
					]),
				)
			: {};
		skills = {
			status: "loaded",
			descriptors: available.map((s) => ({
				slug: s.slug,
				name: s.name,
				version: s.version,
				hash: createHash("sha256")
					.update(JSON.stringify(s))
					.digest("hex"),
			})),
			systemBlock: buildSkillsSystemBlock(available),
			tools,
		};
		if (
			Buffer.byteLength(JSON.stringify(skills)) >
			MAX_SKILLS_SNAPSHOT_BYTES
		) {
			skills = {
				status: "unavailable",
				failure: "too_large",
				descriptors: [],
				systemBlock: null,
				tools: {},
			};
		}
	} catch {
		// Record failure as data, so an activity on another worker cannot drop skills in round 2.
		skills = {
			status: "unavailable",
			failure: "load_failed",
			descriptors: [],
			systemBlock: null,
			tools: {},
		};
	}
	const selection = await getAiModelWithSelection(
		input.userId,
		input.organizationId,
		input.hasTools === true || Object.keys(skills.tools).length > 0,
		input.modelOverride,
		undefined,
		{
			...usageOriginFields(input),
			callPurpose: AI_CALL_PURPOSES.mainRound,
		},
	);
	const model = selection.answerSnapshot();
	if (!model) {
		throw new Error("Model selection did not return an answer route");
	}
	const snapshot: AdvisorAnswerSnapshot = { version: 1, skills, model };
	console.info("advisor.answer_snapshot", {
		bytes: Buffer.byteLength(JSON.stringify(snapshot)),
		skillCount: skills.descriptors.length,
		skillsStatus: skills.status,
		failure: skills.failure,
		skillsHash: createHash("sha256")
			.update(JSON.stringify(skills))
			.digest("hex"),
	});
	return { snapshot };
}
