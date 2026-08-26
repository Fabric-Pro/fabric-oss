import {
	Permissions,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import { db } from "../../client";
import {
	getEnabledRecipientsForCategory,
	getRecipientsWithEmailFlagEnabled,
} from "../notification-preferences";

/**
 * Batched recipient resolution for publishing notifications (§9.2).
 *
 * This DUPLICATES the precedence of resolveEffectiveProjectPermissions
 * (packages/api/lib/effective-project-permissions.ts) because @repo/api depends on
 * @repo/database and not the reverse — the same documented reason
 * newsletter-review-recipients.ts duplicates it. If that resolver's precedence changes, change it
 * here too; its doc-comment names both duplicates and points back at this file, which is what makes
 * the change discoverable from the authority's side rather than only from this one.
 *
 *   A. personal-project owner → OWNER project permissions
 *   C. an ACTIVE (accepted, unexpired) ProjectMember row is AUTHORITATIVE — its role decides and
 *      the org role is NOT consulted. This is NOT restricted to organization projects.
 *   B. otherwise, and only when the project has a host organization, the org role decides
 *
 * It diverges from the newsletter helper in three ways, not two: it batches a whole roster rather
 * than one project's reviewers, its predicate is PUBLISHING_TOPIC_CREATE rather than
 * PROJECT_SETTINGS_EDIT, and its personal-project branch consults ProjectMember instead of
 * stopping at the owner.
 *
 * On the predicate: PUBLISHING_TOPIC_READ is granted to VIEWERS at BOTH levels, so filtering on it
 * would notify precisely the read-only members FR24/FR25 forbid. CREATE is Editor+ at project
 * level and org-member+ at organization level, and it is the better semantic match — the
 * notification asks someone to act on a topic, so the audience is the people who can.
 */
export type PublishingProjectMemberRow = {
	userId: string;
	role: string;
	acceptedAt: Date | null;
	expiresAt: Date | null;
};

export type PublishingOrgMemberRow = { userId: string; role: string };

function isActive(member: PublishingProjectMemberRow, now: Date): boolean {
	return (
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > now)
	);
}

function canCreateTopics(permissions: readonly string[]): boolean {
	return permissions.includes(Permissions.PUBLISHING_TOPIC_CREATE);
}

/** Pure core: rows in, recipient ids out. `now` is injected so expiry is deterministic in tests. */
export function selectPublishingRecipientIds(input: {
	project: { organizationId: string | null; userId: string | null };
	members: PublishingProjectMemberRow[];
	orgMembers: PublishingOrgMemberRow[];
	now: Date;
}): string[] {
	const { project, members, orgMembers, now } = input;
	const recipients: string[] = [];

	// Path A — personal-project owner. A test on one person, NOT a short-circuit for the project:
	// everyone else still falls through to Path C below. The authority resolves this person to the
	// OWNER permission set rather than to "always allowed", so the same capability predicate runs
	// here — if OWNER ever stopped granting PUBLISHING_TOPIC_CREATE, an unconditional push would
	// notify someone who can no longer act on the topic.
	const isPersonal = project.organizationId === null;
	if (isPersonal && project.userId) {
		if (canCreateTopics(resolveProjectPermissions("OWNER"))) {
			recipients.push(project.userId);
		}
	}

	// Path C — an active ProjectMember row is authoritative, and this is NOT restricted to
	// organization projects.
	const active = members.filter((m) => isActive(m, now));
	const activeIds = new Set(active.map((m) => m.userId));
	for (const member of active) {
		if (isPersonal && member.userId === project.userId) {
			// Already decided by Path A, whose OWNER role outranks any member row. The authority
			// returns at Path A for this person and never reads their ProjectMember row, so this
			// skip is unconditional on the PATH, not on whether Path A actually pushed them.
			continue;
		}
		if (canCreateTopics(resolveProjectPermissions(member.role))) {
			recipients.push(member.userId);
		}
	}

	// Path B — org-role fallback, reachable only when the project has an organization AND the user
	// has no active project row. Excluding the INACTIVE ones too would drop an org admin whose
	// project invitation merely lapsed, who can still act on these topics.
	if (project.organizationId) {
		for (const orgMember of orgMembers) {
			if (activeIds.has(orgMember.userId)) {
				continue;
			}
			if (canCreateTopics(resolveOrgPermissions(orgMember.role))) {
				recipients.push(orgMember.userId);
			}
		}
	}

	return [...new Set(recipients)];
}

/**
 * Reads the roster and applies the pure core. Returns null when the project no longer exists.
 *
 * Every id this returns is a RECIPIENT. `Project.userId` participates only as the personal-project
 * owner test — on an organization project it is the denormalized tenant owner and carries no
 * notification meaning at all, which is why Path A is gated on `organizationId === null`.
 */
export async function resolvePublishingEligibleRecipients(input: {
	projectId: string;
	now?: Date;
}): Promise<string[] | null> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { organizationId: true, userId: true },
	});
	if (!project) {
		return null;
	}

	const [members, orgMembers] = await Promise.all([
		db.projectMember.findMany({
			where: { projectId: input.projectId },
			select: {
				userId: true,
				role: true,
				acceptedAt: true,
				expiresAt: true,
			},
		}),
		project.organizationId
			? db.member.findMany({
					where: { organizationId: project.organizationId },
					select: { userId: true, role: true },
				})
			: Promise.resolve([]),
	]);

	return selectPublishingRecipientIds({
		project,
		members,
		orgMembers,
		now: input.now ?? new Date(),
	});
}

/**
 * Relevance (§9.2(b)) — PERSISTED SIGNALS ONLY, over the topics this cycle inserted:
 * `contributorUserIds` containing the user, union `relevantFunctionTags` intersecting the user's
 * function tags, and the second only when the function-tags flag is on.
 *
 * The per-viewer author-recommendation fit is deliberately NOT in this union. authorRecommendation,
 * rankReason, whySuggested and meetingSpeakers are computed per request and per viewer inside
 * listPublishingTopics and are not columns on PublishingTopic; a background activity could reach
 * them only by re-running that enrichment once per member or extracting it into a shared path, and
 * the product owner declined the extraction.
 *
 * The consequence is recorded rather than glossed: with the flag off, reach is attribution-only, a
 * topic with empty contributorUserIds notifies nobody, and a cycle may legitimately notify nobody.
 */
export async function selectRelevantRecipientIds(input: {
	projectId: string;
	cycleId: string;
	candidateUserIds: string[];
}): Promise<string[]> {
	if (input.candidateUserIds.length === 0) {
		return [];
	}

	const topics = await db.publishingTopic.findMany({
		where: { projectId: input.projectId, cycleId: input.cycleId },
		select: { contributorUserIds: true, relevantFunctionTags: true },
	});

	const candidates = new Set(input.candidateUserIds);
	const relevant = new Set<string>();
	const cycleTags = new Set<string>();
	for (const topic of topics) {
		for (const userId of topic.contributorUserIds) {
			if (candidates.has(userId)) {
				relevant.add(userId);
			}
		}
		for (const tag of topic.relevantFunctionTags) {
			cycleTags.add(tag);
		}
	}

	// The established pattern is to skip the query ENTIRELY when the flag is off, rather than run
	// it and discard the result.
	if (!isFunctionTagsEnabled() || cycleTags.size === 0) {
		return [...relevant];
	}

	const tagRows = await db.projectUserFunctionTag.findMany({
		where: {
			projectId: input.projectId,
			userId: { in: input.candidateUserIds },
		},
		select: { userId: true, tags: true },
	});
	for (const row of tagRows) {
		if (row.tags.some((tag) => cycleTags.has(tag))) {
			relevant.add(row.userId);
		}
	}

	return [...relevant];
}

/**
 * Does the project STILL belong to the tenant the cycle was created under, and is it still a
 * project we may notify about at all? (§9.2(d))
 *
 * Split out of `reauthorizePublishingRecipient` below rather than folded into it, for two reasons.
 * The batch caller needs the tenancy question ALONE — a single helper handed an empty
 * `recipientUserId` would also evaluate the permission half and answer RECIPIENT_UNAUTHORIZED for a
 * user that does not exist. And permission and tenancy are separate questions, so the code should
 * say they are separate.
 *
 * `TENANT_CHANGED` is the one negative answer, and it covers more than its name's literal reading:
 * the project moved to a different tenant, OR it became ineligible (archived / soft-deleted) after
 * the cycle was dispatched. Callers behave identically for both — write nothing — so the verdict
 * deliberately does not distinguish them. Eligibility is part of THIS check for the same reason it
 * is part of persistCycleTerminal's F1 guard: a project archived after dispatch must not have its
 * members told about it either.
 *
 * This is a cheap PRE-CHECK, never the fence. Every path in publishing-notification-delivery.ts
 * that creates a ledger row re-asserts tenancy inside its own transaction, holding the project row
 * FOR UPDATE — which BLOCKS a concurrent transfer rather than merely noticing one afterwards. This
 * read takes no lock and its answer is stale the moment it returns; it exists to avoid doing
 * pointless work for a whole batch, and both layers are kept.
 */
export async function assertPublishingCycleTenant(input: {
	projectId: string;
	cycleTenant: { organizationId: string | null; userId: string | null };
}): Promise<"OK" | "TENANT_CHANGED"> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: {
			organizationId: true,
			userId: true,
			status: true,
			deletedAt: true,
		},
	});
	if (!project || project.status !== "ACTIVE" || project.deletedAt !== null) {
		return "TENANT_CHANGED";
	}

	// Normalize the project's CURRENT tuple the same way the cycle's was normalized at creation:
	// organization context carries a null tenant userId.
	const currentOrg = project.organizationId ?? null;
	const currentUser = currentOrg === null ? project.userId : null;
	return currentOrg === input.cycleTenant.organizationId &&
		currentUser === input.cycleTenant.userId
		? "OK"
		: "TENANT_CHANGED";
}

/**
 * The delivery channels this module can re-authorize for. A string union rather than an enum for
 * the same reason the ledger's `channel` column is TEXT: 1C-3 adds CHAT and that must not cost an
 * irreversible migration.
 */
export type PublishingNotificationChannel = "IN_APP" | "EMAIL";

/**
 * Re-authorize ONE recipient immediately before their delivery (§9.2(d)). Resolution happens once,
 * but delivery happens later and across attempts, and the world moves in between.
 *
 * THREE conditions, and none of them implies another:
 *
 *   1. tenancy — resolveEffectiveProjectPermissions returns the CURRENT project's organizationId
 *      and treats an active ProjectMember row as authoritative; it never compares that tenant to
 *      the cycle's, because it is never told what the cycle is. A recipient who keeps an active
 *      project role across a transfer therefore passes the permission check while belonging to a
 *      different tenant than the cycle.
 *   2. permission — the capability predicate, re-derived from the current roster rows.
 *   3. the TOGGLE, and which one depends on `channel`: IN_APP reads the PUBLISHING category toggle
 *      (`publishingSuggestions`, via getEnabledRecipientsForCategory) and EMAIL reads the
 *      `publishingEmails` flag (via getRecipientsWithEmailFlagEnabled) — two independent columns,
 *      not one column read two ways. The batch answer each helper would give for a whole candidate
 *      set is a snapshot taken once, so a user who opts out after it and before their own delivery
 *      would still be notified — an opt-out that visibly does not take effect. It is re-checked HERE
 *      rather than inside the delivery transaction so the delivery module never has to know that
 *      notification preferences exist.
 *
 * A fresh read every time, never a cached copy of the batch answer: a batch check taken once leaves
 * a window that widens with the batch, and a timed-out execution keeps running, so that window
 * outlives the attempt boundary entirely.
 *
 * THE RESIDUAL IS NARROWED, NOT CLOSED, and the honest bound is worth stating rather than implying:
 * an opt-out that commits between this function returning OK and the delivery transaction
 * committing is still notified. That window is one recipient's delivery transaction — a fence read,
 * a ledger write and a bell write — instead of "the whole batch plus every earlier recipient's
 * delivery, across every attempt". Closing it to zero would mean reading the preference inside the
 * delivery transaction under the project lock, which buys a strictly smaller window at the cost of
 * teaching the ledger about a per-user setting that is not tenant state. The product decision is
 * that a bell the user asked not to receive, sent within one transaction of them asking, is
 * acceptable; a bell sent minutes later is not.
 */
export async function reauthorizePublishingRecipient(input: {
	projectId: string;
	recipientUserId: string;
	cycleTenant: { organizationId: string | null; userId: string | null };
	channel: PublishingNotificationChannel;
	now?: Date;
}): Promise<"OK" | "RECIPIENT_UNAUTHORIZED" | "TENANT_CHANGED"> {
	// Tenancy first. Permission is only a meaningful question once the project is still the cycle's
	// — a recipient who kept their role across a transfer is authorized on a project that is no
	// longer this cycle's, and answering OK there is the leak §9.2(d) forbids.
	if (
		(await assertPublishingCycleTenant({
			projectId: input.projectId,
			cycleTenant: input.cycleTenant,
		})) === "TENANT_CHANGED"
	) {
		return "TENANT_CHANGED";
	}

	// The gate just asserted the project's normalized tuple EQUALS the cycle's, so the cycle tuple
	// is the project's current tenancy and re-reading the project would only widen the window. The
	// pure core reads `project.userId` solely through its personal-project owner test, which is
	// gated on `organizationId === null` — the one case in which the normalized tenant userId IS
	// the project's owner column.
	const currentOrg = input.cycleTenant.organizationId;

	const [member, orgMember] = await Promise.all([
		db.projectMember.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: input.recipientUserId,
				},
			},
			select: {
				userId: true,
				role: true,
				acceptedAt: true,
				expiresAt: true,
			},
		}),
		currentOrg
			? db.member.findFirst({
					where: {
						organizationId: currentOrg,
						userId: input.recipientUserId,
					},
					select: { userId: true, role: true },
				})
			: Promise.resolve(null),
	]);

	const allowed = selectPublishingRecipientIds({
		project: {
			organizationId: currentOrg,
			userId: input.cycleTenant.userId,
		},
		members: member ? [member] : [],
		orgMembers: orgMember ? [orgMember] : [],
		now: input.now ?? new Date(),
	});
	if (!allowed.includes(input.recipientUserId)) {
		return "RECIPIENT_UNAUTHORIZED";
	}

	// The toggle, re-read for this ONE recipient, on the channel this call is about.
	// RECIPIENT_UNAUTHORIZED is the verdict for it because it is what the value means — a decision
	// ABOUT this person, not about the project — and because the ledger's skip reasons are a closed
	// set that later slices bind to.
	//
	// REQUIRED parameter, deliberately. A default would make the wrong answer the quiet one: an
	// email send re-authorized against the bell's toggle notifies a user who switched publishing
	// emails off, and nothing anywhere reports an error. Making the caller name the channel is
	// what turns that into a compile error.
	//
	// Both branches reuse a batch helper rather than reading the row directly, so the opt-out
	// semantics — a missing row means enabled, only an explicit `false` drops — are defined in
	// exactly one place per channel.
	//
	// EXHAUSTIVE switch, not a two-way ternary: this function's whole purpose is refusing to guess a
	// channel, so a channel added to PublishingNotificationChannel that this switch does not name
	// must fail to compile rather than silently inherit another channel's toggle — a ternary's
	// `else` arm means "not IN_APP", which is a different claim from "is EMAIL", and the gap between
	// those two claims is exactly the bug this function exists to prevent.
	let stillEnabled: Set<string>;
	switch (input.channel) {
		case "IN_APP":
			stillEnabled = await getEnabledRecipientsForCategory(
				[input.recipientUserId],
				"PUBLISHING",
			);
			break;
		case "EMAIL":
			stillEnabled = await getRecipientsWithEmailFlagEnabled(
				[input.recipientUserId],
				"publishingEmails",
			);
			break;
		default: {
			const exhaustive: never = input.channel;
			throw new Error(
				`Unhandled publishing notification channel: ${exhaustive}`,
			);
		}
	}
	if (!stillEnabled.has(input.recipientUserId)) {
		return "RECIPIENT_UNAUTHORIZED";
	}

	return "OK";
}
