/**
 * Capture-time AI suggestion of decision tagging metadata (Fizzy #2029):
 * a type from the project's evolving taxonomy, how long the decision stands,
 * whether it should drive roadmap prioritization, and an accountable owner.
 *
 * Pure — no database writes. A proposed type that is NOT one of the existing
 * labels comes back as a new name; only when a caller SAVES does a DecisionType
 * row get minted for it, so form-discarded suggestions never fragment the
 * taxonomy. (The meeting-ingestion path mints at draft-capture time instead —
 * see applyMeetingDecisionTagging.) Best-effort: any failure returns null and
 * the decision simply ships untagged until a human fills it in.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import {
	db,
	getProjectMemberFunctionTags,
	listDecisionTypes,
} from "@repo/database";
import { zodSchema } from "ai";
import { z } from "zod";

const SuggestionSchema = z.object({
	decisionType: z
		.string()
		.describe(
			"The decision type label: copy one of the project's existing types verbatim when one fits, otherwise a short (1-3 word) new label.",
		),
	duration: z
		.enum(["LONG_STANDING", "SHORT_TERM"])
		.describe(
			"LONG_STANDING when the decision is standing guidance until explicitly revised; SHORT_TERM when it is bound to a deadline or milestone.",
		),
	priorityFlagged: z
		.boolean()
		.describe(
			"True only when the decision itself establishes prioritization guidance that should drive roadmap ranking.",
		),
	ownerUserId: z
		.string()
		.nullable()
		.describe(
			"The candidate userId best placed to own this decision, or null when no candidate clearly fits.",
		),
	reason: z
		.string()
		.describe("One short sentence explaining the suggestions."),
});

interface DecisionOwnerCandidate {
	userId: string;
	name: string;
	functionTags: string[];
}

export interface SuggestDecisionMetadataInput {
	title: string;
	decision: string;
	contextProblem?: string | null;
	participantsText?: string | null;
	existingTypes: string[];
	ownerCandidates: DecisionOwnerCandidate[];
	tenantFilter: { userId: string; organizationId?: string | null };
}

export interface DecisionMetadataSuggestion {
	/** Existing label copied verbatim, or a proposed NEW label. */
	decisionType: string;
	duration: "LONG_STANDING" | "SHORT_TERM";
	priorityFlagged: boolean;
	ownerUserId: string | null;
	reason: string;
}

function buildPrompt(input: SuggestDecisionMetadataInput): string {
	const typeLines =
		input.existingTypes.length > 0
			? input.existingTypes.map((t) => `- ${t}`).join("\n")
			: "(none yet — propose the first label)";
	const candidates =
		input.ownerCandidates.length > 0
			? input.ownerCandidates
					.map(
						(c) =>
							`- ${c.userId} (${c.name})${
								c.functionTags.length > 0
									? ` — roles: ${c.functionTags.join(", ")}`
									: ""
							}`,
					)
					.join("\n")
			: "(none)";
	return `Classify a recorded product/architecture decision for tagging.

DECISION TITLE:
${input.title}

DECISION:
${input.decision}
${input.contextProblem ? `\nCONTEXT:\n${input.contextProblem}\n` : ""}${
	input.participantsText
		? `\nEXTERNAL PARTICIPANTS: ${input.participantsText}\n`
		: ""
}
1. TYPE — pick from the project's existing taxonomy (copy verbatim, exact case):
${typeLines}
Only if none fits may you propose ONE new short label (1-3 words, Title Case).

2. DURATION:
- LONG_STANDING: standing guidance that holds until explicitly revised (e.g. "security reviews are always release-blocking").
- SHORT_TERM: bound to a horizon — a deadline, milestone or one-off initiative (e.g. "complete the compliance audit by end of quarter").

3. PRIORITY FLAG: set true ONLY when the decision itself says something about what to build/fix first (bug-vs-feature stance, area emphasis, capacity guidance). A merely important technical choice is not a priority decision.

4. OWNER — exactly one accountable owner, chosen by fit between the decision's subject and each candidate's role:
${candidates}
Use the candidate id verbatim; null when nobody clearly fits.

Return reason as one short sentence.`;
}

/**
 * Load the two project-scoped inputs the suggestion needs: the existing
 * taxonomy labels and the roster with its function tags (resolved to display
 * names). Shared by both callers — the form's suggest endpoint and
 * meeting-ingestion — so a change to who counts as an owner candidate cannot
 * apply to one and not the other.
 */
export async function loadSuggestionContext(projectId: string): Promise<{
	existingTypes: string[];
	ownerCandidates: DecisionOwnerCandidate[];
}> {
	const [types, taggedMembers] = await Promise.all([
		listDecisionTypes({ projectId }),
		getProjectMemberFunctionTags(projectId),
	]);
	const users = await db.user.findMany({
		where: { id: { in: taggedMembers.map((m) => m.userId) } },
		select: { id: true, name: true, email: true },
	});
	const nameById = new Map(
		users.map((u) => [u.id, u.name || u.email || u.id]),
	);
	return {
		existingTypes: types.map((t) => t.name),
		ownerCandidates: taggedMembers.map((m) => ({
			userId: m.userId,
			name: nameById.get(m.userId) ?? m.userId,
			functionTags: m.tags,
		})),
	};
}

/**
 * Suggest tagging metadata for a decision being captured or edited. Never
 * throws; returns null on any model/validation failure.
 */
export async function suggestDecisionMetadata(
	input: SuggestDecisionMetadataInput,
): Promise<DecisionMetadataSuggestion | null> {
	try {
		const { model } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: input.tenantFilter.userId,
				organizationId: input.tenantFilter.organizationId ?? undefined,
				featureKey: "decision-tagging",
			},
		);

		const { object } = await generateObject({
			model,
			schema: zodSchema(SuggestionSchema),
			prompt: buildPrompt(input),
		});

		const ownerIds = new Set(input.ownerCandidates.map((c) => c.userId));
		const proposedType = object.decisionType.trim();
		if (!proposedType) {
			return null;
		}
		// An existing label must be matched case-insensitively to the real row,
		// so the form can preselect it instead of offering a near-duplicate.
		const existing = input.existingTypes.find(
			(t) => t.toLowerCase() === proposedType.toLowerCase(),
		);
		return {
			decisionType: existing ?? proposedType,
			duration: object.duration,
			priorityFlagged: object.priorityFlagged,
			ownerUserId:
				object.ownerUserId && ownerIds.has(object.ownerUserId)
					? object.ownerUserId
					: null,
			reason: object.reason,
		};
	} catch {
		return null;
	}
}
