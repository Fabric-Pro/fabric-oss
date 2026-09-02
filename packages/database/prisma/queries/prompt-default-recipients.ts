import { db } from "../client";

/**
 * Who should hear that a tier's default prompt changed, and how it is framed.
 *
 * Fizzy #2068 FR6. Two rules decide the audience, and the second is a
 * deliberate narrowing worth reading before changing it.
 *
 * ORGANIZATION tier — every member of that organization is subject to the
 * change, so every member hears about it.
 *
 * UNIVERSAL tier — a literal reading of FR6 is "every user in every
 * organization without an override", which is a platform-wide message on every
 * system prompt edit. That is a volume decision rather than a correctness one,
 * and it is not one a prompt edit should make silently. The audience is
 * therefore organization owners and admins: they are subject to the change AND
 * they are the people who can act on it, which is what FR8 asks the
 * notification to enable. A member who cannot change any default would receive
 * a message whose only possible action is to ask an admin.
 *
 * Framing — a recipient holding their own override is not affected by the
 * change, so their notification says an improvement is available rather than
 * implying something moved under them. That is FR6's informational case.
 */
export type PromptDefaultRecipient = {
	userId: string;
	organizationId: string | null;
	/** True when this user's own override still wins, so nothing changed for them. */
	hasOwnOverride: boolean;
};

/** Everyone subject to a tier, before any single action narrows the framing. */
export type PromptDefaultAudience = {
	userId: string;
	organizationId: string | null;
}[];

/**
 * Who is subject to this tier at all.
 *
 * Split out from the recipient list because it depends only on the tier, never
 * on the action: one prompt edit can win several actions, and resolving the same
 * audience once per action means re-running this scan N times on the author's
 * save. The SYSTEM branch has no organization to filter by, so it reads every
 * admin and owner on the platform — the one query here worth not repeating.
 */
export async function listPromptDefaultAudience({
	scope,
	organizationId,
	excludeUserId,
}: {
	scope: "SYSTEM" | "ORG";
	organizationId?: string | null;
	/** The actor. Telling someone about their own edit is noise. */
	excludeUserId?: string;
}): Promise<PromptDefaultAudience> {
	const members =
		scope === "ORG"
			? organizationId
				? await db.member.findMany({
						where: { organizationId },
						select: { userId: true, organizationId: true },
					})
				: []
			: await db.member.findMany({
					where: { role: { in: ["admin", "owner"] } },
					select: { userId: true, organizationId: true },
				});

	const seen = new Set<string>();
	const audience: PromptDefaultAudience = [];
	for (const m of members) {
		if (m.userId === excludeUserId || seen.has(m.userId)) {
			continue;
		}
		seen.add(m.userId);
		audience.push({ userId: m.userId, organizationId: m.organizationId });
	}
	return audience;
}

/**
 * Frame one action's notice for an audience already resolved.
 *
 * This half genuinely is per-action: whether a reader holds their own override
 * for THIS action decides whether the notice says something moved under them or
 * that an improvement is available.
 */
export async function markOwnOverrides({
	audience,
	targetKey,
	documentType,
	storyKind,
}: {
	audience: PromptDefaultAudience;
	targetKey: string;
	documentType: string;
	storyKind?: string | null;
}): Promise<PromptDefaultRecipient[]> {
	if (audience.length === 0) {
		return [];
	}

	const overrides = await db.promptBinding.findMany({
		where: {
			targetType: "AGENT" as any,
			targetKey,
			documentType,
			storyKind: (storyKind ?? null) as any,
			scope: "USER" as any,
			isDefault: true,
			userId: { in: audience.map((a) => a.userId) },
		},
		select: { userId: true },
	});
	const overridden = new Set(overrides.map((o) => o.userId));

	return audience.map((a) => ({
		userId: a.userId,
		organizationId: a.organizationId,
		hasOwnOverride: overridden.has(a.userId),
	}));
}

/**
 * The whole answer for a single action. Callers announcing several actions of
 * one prompt should resolve the audience once and call `markOwnOverrides` per
 * action instead.
 */
export async function listPromptDefaultRecipients({
	scope,
	organizationId,
	targetKey,
	documentType,
	storyKind,
	excludeUserId,
}: {
	scope: "SYSTEM" | "ORG";
	organizationId?: string | null;
	targetKey: string;
	documentType: string;
	storyKind?: string | null;
	/** The actor. Telling someone about their own edit is noise. */
	excludeUserId?: string;
}): Promise<PromptDefaultRecipient[]> {
	const audience = await listPromptDefaultAudience({
		scope,
		organizationId,
		excludeUserId,
	});
	return markOwnOverrides({ audience, targetKey, documentType, storyKind });
}
