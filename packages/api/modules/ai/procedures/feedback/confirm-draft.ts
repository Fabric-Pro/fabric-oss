import { recordAiOutcome } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const fields = {
	draftId: z.string().min(1).max(128),
	verdict: z.enum(["accepted", "accepted-with-edits", "rejected"]),
};
const inputSchema = z.union([
	z
		.object({
			...fields,
			surface: z.literal("topic-analysis"),
			projectId: z.string().min(1).max(128),
			verdict: z.literal("rejected"),
		})
		.strict(),
	z
		.object({
			...fields,
			surface: z.enum(["feature-spec", "document"]),
			projectId: z.string().min(1).max(128),
		})
		.strict(),
	z
		.object({
			...fields,
			surface: z.enum(["prompt-enhancer", "document-generator"]),
		})
		.strict(),
]);
const featureKeys = {
	"feature-spec": "document-generation",
	document: "document-generation",
	"document-generator": "agent-document-generation",
	"topic-analysis": "publishing-suite",
	"prompt-enhancer": "prompt-enhancement",
} as const;
const subjectTypes = {
	"feature-spec": "feature-spec-draft",
	document: "document-draft",
	"document-generator": "agent-document-draft",
	"topic-analysis": "publishing-analysis",
	"prompt-enhancer": "prompt-enhancement-draft",
} as const;
const outcomes = {
	accepted: "ACCEPTED_AS_IS",
	"accepted-with-edits": "ACCEPTED_WITH_EDITS",
	rejected: "REJECTED",
} as const;
const projectPermission = requireProjectPermission(Permissions.PROJECT_UPDATE);
// Match analysis-revision.ts: PUBLISHING_TOPIC_UPDATE authorizes analysis writes.
const topicPermission = requireProjectPermission(
	Permissions.PUBLISHING_TOPIC_UPDATE,
);
const chatPermission = requirePermission(Permissions.AI_CHAT);

export const confirmAiDraft = tenantProtectedProcedure
	.input(inputSchema)
	.use((options, input, output) => {
		if (input.surface === "topic-analysis") {
			return topicPermission(options, input, output);
		}
		if ("projectId" in input) {
			return projectPermission(options, input, output);
		}
		// Projectless verdicts concern only the caller's own output, like rate-output.
		// They touch no prompt or agent resource and use the session tenant and AI_CHAT.
		return chatPermission(options, input, output);
	})
	.route({
		method: "POST",
		path: "/ai/feedback/confirm-draft",
		tags: ["AI"],
		summary: "Record a human verdict on an AI draft",
	})
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);
		try {
			await recordAiOutcome({
				featureKey: featureKeys[input.surface],
				subjectType: subjectTypes[input.surface],
				subjectId: input.draftId,
				outcome: outcomes[input.verdict],
				userId: context.user.id,
				organizationId,
				projectId: "projectId" in input ? input.projectId : null,
				modelCanonicalName: null,
				promptVersionId: null,
			});
		} catch (error) {
			logger.warn("[confirm-draft] outcome capture failed", { error });
		}
		return {};
	});
