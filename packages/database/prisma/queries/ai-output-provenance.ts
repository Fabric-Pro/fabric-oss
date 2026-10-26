import { db } from "../client";

interface OutputSubject {
	organizationId: string;
	userId: string;
	subjectType: string;
	subjectId: string;
}

/** The usage route supplies authenticated identity and a verified project. */
export async function recordAiOutputProvenance(
	params: OutputSubject & {
		projectId?: string | null;
		agentId?: string | null;
		modelCanonicalName?: string | null;
	},
) {
	const { organizationId, userId, subjectType, subjectId } = params;
	const snapshot = {
		projectId: params.projectId ?? null,
		agentId: params.agentId ?? null,
		modelCanonicalName: params.modelCanonicalName ?? null,
		// Chat prompts are assembled in code, without a stored PromptVersion.
		promptVersionId: null,
	};
	return db.aiOutputProvenance.upsert({
		where: {
			organizationId_userId_subjectType_subjectId: {
				organizationId,
				userId,
				subjectType,
				subjectId,
			},
		},
		create: { organizationId, userId, subjectType, subjectId, ...snapshot },
		update: snapshot,
	});
}

/** Resolve only the requesting user's output within the resolved organization. */
export async function getAiOutputProvenance(subject: OutputSubject) {
	return db.aiOutputProvenance.findUnique({
		where: { organizationId_userId_subjectType_subjectId: subject },
		select: {
			projectId: true,
			modelCanonicalName: true,
			promptVersionId: true,
		},
	});
}
