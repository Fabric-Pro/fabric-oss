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

	if (members.length === 0) {
		return [];
	}

	const candidateIds = [
		...new Set(
			members.map((m) => m.userId).filter((id) => id !== excludeUserId),
		),
	];
	if (candidateIds.length === 0) {
		return [];
	}

	// A personal override for this exact action means the change does not alter
	// what this user gets — they still hear, but framed as informational.
	const overrides = await db.promptBinding.findMany({
		where: {
			targetType: "AGENT" as any,
			targetKey,
			documentType,
			storyKind: (storyKind ?? null) as any,
			scope: "USER" as any,
			isDefault: true,
			userId: { in: candidateIds },
		},
		select: { userId: true },
	});
	const overridden = new Set(overrides.map((o) => o.userId));

	const seen = new Set<string>();
	const recipients: PromptDefaultRecipient[] = [];
	for (const m of members) {
		if (m.userId === excludeUserId || seen.has(m.userId)) {
			continue;
		}
		seen.add(m.userId);
		recipients.push({
			userId: m.userId,
			organizationId: m.organizationId,
			hasOwnOverride: overridden.has(m.userId),
		});
	}

	return recipients;
}
