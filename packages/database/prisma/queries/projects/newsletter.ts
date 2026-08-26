/**
 * Database queries for the external release-notes newsletter.
 * Uses the raw `db` client (BYPASSRLS); callers pass tenant columns explicitly.
 */
import { randomBytes } from "node:crypto";
import type {
	NewsletterApprovalChatChannel,
	NewsletterChatChannel,
	NewsletterChatDeliveryKind,
	NewsletterContent,
	NewsletterDeliveryDestination,
	NewsletterDetailLevel,
	NewsletterSendStatus,
	NewsletterSkipReason,
} from "../../../src/newsletter-schema";
import {
	STALE_APPROVAL_TTL_MS,
	STALE_APPROVED_MS,
} from "../../../src/newsletter-schema";
import { db, Prisma } from "../../client";
import { recordAuditTx } from "../audit-log";
import { getProjectMembers } from "./members";

export function generateUnsubscribeToken(): string {
	return randomBytes(32).toString("base64url");
}

export function newsletterSettingsDefaults(projectId: string) {
	return {
		id: null as string | null,
		projectId,
		enabled: false,
		cadence: "WEEKLY",
		dayOfWeek: 1,
		dayOfMonth: 1,
		sendHourUtc: 9,
		lastSentAt: null as Date | null,
		lookbackDays: null as number | null,
		detailLevel: "STANDARD",
		deliveryDestination: "EMAIL",
		chatChannels: [] as NewsletterChatChannel[],
		approvalChatChannels: [] as NewsletterApprovalChatChannel[],
		requireApproval: false,
		// Per-project embeddable widget fields: present (defaulted) so a project
		// with NO settings row still yields defined widget fields on first load.
		publicWidgetEnabled: false,
		publicEmbedToken: null as string | null,
		publicEmbedTokenVersion: 1,
		publicWidgetTheme: null as string | null,
		publicWidgetAccent: null as string | null,
		publicWidgetConfig: null as unknown,
		createdAt: null as Date | null,
		updatedAt: null as Date | null,
	};
}

// ---- Settings ----
export async function getNewsletterSettings(projectId: string) {
	const s = await db.newsletterSettings.findUnique({ where: { projectId } });
	return s ?? newsletterSettingsDefaults(projectId);
}

// ---- Embeddable per-project widget ----

/** Transaction client type — the param Prisma passes to an interactive
 * `db.$transaction(async (tx) => …)` callback. Lets a caller compose the
 * widget-state toggle inside one transaction with the settings upsert + audit. */
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Resolve a project + its widget config from an opaque embed token. Returns null
 * for an unknown/empty token. The token is the public, revocable handle a 3rd-party
 * site embeds with; downstream consumers gate on `publicWidgetEnabled`.
 */
export async function resolveProjectByEmbedToken(token: string) {
	if (!token) {
		return null;
	}
	const s = await db.newsletterSettings.findUnique({
		where: { publicEmbedToken: token },
		select: {
			projectId: true,
			organizationId: true,
			userId: true,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: true,
			publicWidgetTheme: true,
			publicWidgetAccent: true,
			publicWidgetConfig: true,
			// Audit actor for the anonymous embed subscribe path. Folded in here so the
			// public subscribe handler needs no second settings query. NewsletterSettings
			// .createdByUserId is non-nullable in the schema (→ `string`), but the
			// handler still falls back to the project owner defensively for legacy or
			// sentinel rows before using it.
			createdByUserId: true,
		},
	});
	if (!s) {
		return null;
	}
	return {
		projectId: s.projectId,
		organizationId: s.organizationId,
		userId: s.userId,
		publicWidgetEnabled: s.publicWidgetEnabled,
		publicEmbedTokenVersion: s.publicEmbedTokenVersion,
		createdByUserId: s.createdByUserId,
		theme: s.publicWidgetTheme,
		accent: s.publicWidgetAccent,
		config: s.publicWidgetConfig,
	};
}

/**
 * Toggle the embeddable widget on/off for a project. MUST run inside a
 * transaction: it takes the row's `SELECT … FOR UPDATE` lock so a concurrent
 * disable can't be lost to a racing enable under READ COMMITTED. The settings
 * row is assumed to exist (upserted before this call); a missing row is a
 * defensive no-op.
 *  - First enable mints the embed token, REUSING version 1 (no bump).
 *  - A real true → false transition bumps the version (durable revocation),
 *    keeping the token so it can be re-enabled (or rotated) later.
 */
export async function setPublicWidgetState(
	projectId: string,
	enabled: boolean,
	client: Tx,
): Promise<{ changed: boolean; token: string; version: number }> {
	// FOR UPDATE only serializes inside an interactive transaction. The base
	// PrismaClient exposes `$transaction`; a TransactionClient does not — reject a
	// non-tx client loudly rather than silently losing the lock guarantee.
	if ("$transaction" in client) {
		throw new Error(
			"setPublicWidgetState requires a transaction client (call inside db.$transaction)",
		);
	}
	const locked = await client.$queryRaw<
		Array<{
			publicWidgetEnabled: boolean;
			publicEmbedToken: string | null;
			publicEmbedTokenVersion: number;
		}>
	>`
		SELECT "publicWidgetEnabled", "publicEmbedToken", "publicEmbedTokenVersion"
		FROM "newsletter_settings" WHERE "projectId" = ${projectId} FOR UPDATE`;
	const cur = locked[0];
	if (!cur) {
		// Unreachable in the real flow (callers upsert the settings row in the same
		// tx before calling). The "" token is a sentinel — NOT a valid token; no
		// current consumer reads `.token` off this return (Task 5 reads only `changed`).
		return { changed: false, token: "", version: 1 };
	}
	const changed = cur.publicWidgetEnabled !== enabled;
	const mintToken = enabled && !cur.publicEmbedToken;
	const updated = await client.newsletterSettings.update({
		where: { projectId },
		data: {
			publicWidgetEnabled: enabled,
			...(mintToken && { publicEmbedToken: generateUnsubscribeToken() }),
			// Bump version only on a REAL true → false transition (durable revocation).
			...(changed &&
				cur.publicWidgetEnabled &&
				!enabled && { publicEmbedTokenVersion: { increment: 1 } }),
		},
		select: { publicEmbedToken: true, publicEmbedTokenVersion: true },
	});
	return {
		changed,
		token: updated.publicEmbedToken ?? "",
		version: updated.publicEmbedTokenVersion,
	};
}

/**
 * Rotate the embed token: mints a brand-new token AND bumps the version, durably
 * revoking any previously-issued embed (and any subscriber stamped at an older
 * `embedTokenVersion`). Optionally composable in a caller's transaction.
 */
export async function regenerateEmbedToken(
	projectId: string,
	client: Tx | typeof db = db,
) {
	// No FOR UPDATE lock here (unlike setPublicWidgetState). Under concurrent rotations
	// the version still increments monotonically (atomic), but publicEmbedToken is
	// last-writer-wins — which is fine: the REVOCATION mechanism is the version gate at
	// confirm (confirmPublicSubscriberByToken), not the token VALUE; any minted token is
	// an equally valid handle. The default `client = db` path is intentionally lock-free
	// and standalone-safe (single atomic UPDATE); the only production caller passes a tx.
	const updated = await client.newsletterSettings.update({
		where: { projectId },
		data: {
			publicEmbedToken: generateUnsubscribeToken(),
			publicEmbedTokenVersion: { increment: 1 },
		},
		select: { publicEmbedToken: true, publicEmbedTokenVersion: true },
	});
	return {
		token: updated.publicEmbedToken ?? "",
		version: updated.publicEmbedTokenVersion,
	};
}

export async function upsertNewsletterSettings(
	projectId: string,
	data: {
		enabled?: boolean;
		cadence?: string;
		dayOfWeek?: number;
		dayOfMonth?: number;
		sendHourUtc?: number;
		lookbackDays?: number | null;
		detailLevel?: NewsletterDetailLevel;
		deliveryDestination?: NewsletterDeliveryDestination;
		chatChannels?: NewsletterChatChannel[];
		/** Review-alert targets (Fizzy #2203). Separate from `chatChannels`,
		 *  which is the audience for the published notes. */
		approvalChatChannels?: NewsletterApprovalChatChannel[];
		requireApproval?: boolean;
		// Per-project embeddable-widget presentation. `null` clears a stored
		// value back to the default; `undefined` (omitted) leaves it untouched
		// on update — mirrors how `lookbackDays` distinguishes clear vs no-op.
		// The on/off flag + embed-token lifecycle are NOT set here: they live in
		// `setPublicWidgetState` / `regenerateEmbedToken`, which must run in a
		// transaction so the upsert + toggle + audit commit together.
		publicWidgetTheme?: string | null;
		publicWidgetAccent?: string | null;
		// Validated JSON object from the caller's zod schema. Cast to Prisma's
		// recursive `InputJsonValue` internally (the schema guarantees a JSON-safe
		// record); `null` clears the column via the `JsonNull` sentinel below.
		publicWidgetConfig?: Record<string, unknown> | null;
		userId: string | null;
		organizationId: string | null;
		// The acting user (audit attribution). MUST be a real user id — it is
		// orthogonal to the tenant `userId` column (which is null in org context
		// by XOR design). On scheduled sends this becomes `triggeredByUserId`,
		// which flows into AI model resolution + usage logging, so a sentinel
		// like "system" would mis-attribute usage. Mirrors addNewsletterSubscriber.
		createdByUserId: string;
	},
	// Optional transaction client so a caller can compose this upsert with the
	// widget toggle + audit row in ONE `db.$transaction`. Defaults to the base
	// `db` for the existing standalone callers.
	client: Tx | typeof db = db,
) {
	const { userId, organizationId, createdByUserId, ...rest } = data;
	// `null` clears the nullable Json column to SQL NULL — use Prisma.DbNull (NOT
	// JsonNull, which would store a JSON literal `null`). `undefined` leaves the
	// column untouched (handled by the spreads). A non-null record is cast to
	// Prisma's recursive InputJsonValue — the caller's zod schema
	// (z.record(z.string(), z.unknown())) guarantees a JSON-safe shape.
	const themeConfigCreate: Prisma.InputJsonValue | typeof Prisma.DbNull =
		rest.publicWidgetConfig === null
			? Prisma.DbNull
			: (rest.publicWidgetConfig as Prisma.InputJsonValue);
	return client.newsletterSettings.upsert({
		where: { projectId },
		create: {
			projectId,
			userId,
			organizationId,
			createdByUserId,
			enabled: rest.enabled ?? false,
			cadence: rest.cadence ?? "WEEKLY",
			dayOfWeek: rest.dayOfWeek ?? 1,
			dayOfMonth: rest.dayOfMonth ?? 1,
			sendHourUtc: rest.sendHourUtc ?? 9,
			lookbackDays: rest.lookbackDays ?? null,
			detailLevel: rest.detailLevel ?? "STANDARD",
			deliveryDestination: rest.deliveryDestination ?? "EMAIL",
			chatChannels: (rest.chatChannels ??
				[]) as unknown as Prisma.InputJsonValue,
			approvalChatChannels: (rest.approvalChatChannels ??
				[]) as unknown as Prisma.InputJsonValue,
			requireApproval: rest.requireApproval ?? false,
			publicWidgetTheme: rest.publicWidgetTheme ?? null,
			publicWidgetAccent: rest.publicWidgetAccent ?? null,
			...(rest.publicWidgetConfig !== undefined && {
				publicWidgetConfig: themeConfigCreate,
			}),
		},
		update: {
			...(rest.enabled !== undefined && { enabled: rest.enabled }),
			...(rest.cadence !== undefined && { cadence: rest.cadence }),
			...(rest.dayOfWeek !== undefined && { dayOfWeek: rest.dayOfWeek }),
			...(rest.dayOfMonth !== undefined && {
				dayOfMonth: rest.dayOfMonth,
			}),
			...(rest.sendHourUtc !== undefined && {
				sendHourUtc: rest.sendHourUtc,
			}),
			...(rest.lookbackDays !== undefined && {
				lookbackDays: rest.lookbackDays,
			}),
			...(rest.detailLevel !== undefined && {
				detailLevel: rest.detailLevel,
			}),
			...(rest.deliveryDestination !== undefined && {
				deliveryDestination: rest.deliveryDestination,
			}),
			...(rest.chatChannels !== undefined && {
				chatChannels:
					rest.chatChannels as unknown as Prisma.InputJsonValue,
			}),
			...(rest.approvalChatChannels !== undefined && {
				approvalChatChannels:
					rest.approvalChatChannels as unknown as Prisma.InputJsonValue,
			}),
			...(rest.requireApproval !== undefined && {
				requireApproval: rest.requireApproval,
			}),
			...(rest.publicWidgetTheme !== undefined && {
				publicWidgetTheme: rest.publicWidgetTheme,
			}),
			...(rest.publicWidgetAccent !== undefined && {
				publicWidgetAccent: rest.publicWidgetAccent,
			}),
			...(rest.publicWidgetConfig !== undefined && {
				publicWidgetConfig: themeConfigCreate,
			}),
			// Refresh the scheduled-send actor on EVERY save. createdByUserId is
			// reused as triggeredByUserId for scheduled sends, so re-homing it to
			// the current acting admin lets an org self-heal stale attribution
			// (e.g. the original creator left the org, or a legacy row still holds
			// the old "system" sentinel): any current admin re-saving settings
			// takes ownership of the scheduled send.
			createdByUserId,
		},
	});
}

/** Whether `userId` is currently a member of `organizationId`. A removed or
 * deleted user has no `member` row (member.userId FK cascades on user delete;
 * leaving the org deletes the row), so absence => not a member. Exported so the
 * AI-resolving activity can re-check at the point of use (TOCTOU). */
export async function isCurrentOrgMember(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	const member = await db.member.findUnique({
		where: { organizationId_userId: { organizationId, userId } },
		select: { id: true },
	});
	return member !== null;
}

/**
 * Whether the stored newsletter actor (createdByUserId) is still allowed to be
 * the AI actor for this project's SCHEDULED sends. Guards the high-cost path:
 * createdByUserId flows into model resolution + usage logging, and org model
 * resolution prefers the actor's PERSONAL provider, so a removed/deleted admin
 * must not keep powering newsletters under their identity.
 *
 *  - Personal context (organizationId null): `createdByUserId` has NO FK, so do
 *    not trust it — require it to equal the project owner (the tenant userId).
 *    Only the owner can create/update a personal project's settings, so this
 *    always holds for well-formed rows; asserting it explicitly refuses any
 *    drifted id or legacy sentinel rather than relying on a cascade.
 *  - Org context: the actor must still be a current member of the org.
 */
export async function isScheduledNewsletterActorValid(
	createdByUserId: string,
	organizationId: string | null,
	ownerUserId: string | null,
): Promise<boolean> {
	if (!organizationId) {
		return ownerUserId !== null && createdByUserId === ownerUserId;
	}
	return isCurrentOrgMember(createdByUserId, organizationId);
}

export async function listEnabledNewsletterSettings() {
	return db.newsletterSettings.findMany({
		where: { enabled: true },
		include: { project: { select: { id: true, name: true } } },
	});
}

export async function advanceNewsletterLastSentAt(
	projectId: string,
	when: Date,
) {
	return db.newsletterSettings.update({
		where: { projectId },
		data: { lastSentAt: when },
	});
}

// ---- Subscribers ----
export async function listNewsletterSubscribers(projectId: string) {
	return db.newsletterSubscriber.findMany({
		// Exclude unconfirmed public sign-ups: they aren't subscribers yet, and the
		// anonymous double opt-in path could otherwise flood the admin settings list.
		where: { projectId, status: { not: "PENDING_CONFIRMATION" } },
		orderBy: { createdAt: "desc" },
	});
}

export async function listActiveNewsletterSubscribers(projectId: string) {
	return db.newsletterSubscriber.findMany({
		where: { projectId, status: "ACTIVE" },
		select: { id: true, email: true, name: true, unsubscribeToken: true },
	});
}

export async function addNewsletterSubscriber(data: {
	projectId: string;
	email: string;
	name?: string | null;
	userId: string | null;
	organizationId: string | null;
	createdByUserId: string;
}) {
	return db.newsletterSubscriber.upsert({
		where: {
			projectId_email: { projectId: data.projectId, email: data.email },
		},
		create: {
			projectId: data.projectId,
			email: data.email,
			name: data.name ?? null,
			userId: data.userId,
			organizationId: data.organizationId,
			createdByUserId: data.createdByUserId,
			unsubscribeToken: generateUnsubscribeToken(),
			status: "ACTIVE",
		},
		// Re-adding a previously-unsubscribed email re-activates it.
		update: {
			status: "ACTIVE",
			unsubscribedAt: null,
			name: data.name ?? undefined,
		},
	});
}

/**
 * Auto-enrol every member of a project (including the owner) as an ACTIVE
 * subscriber, create-if-absent. Uses `createMany({ skipDuplicates })` on the
 * `@@unique([projectId, email])` constraint so it NEVER reactivates an
 * UNSUBSCRIBED row (unlike `addNewsletterSubscriber`, which is for manual
 * admin re-adds) and never duplicates — i.e. idempotent. Suppression is
 * email-level (see spec § Consent model).
 *
 * `createdByUserId` is the audit actor: the enabling admin on the backfill
 * path; on the reconcile-at-send path it is omitted and resolved from the
 * project's NewsletterSettings (always present for an enabled project),
 * falling back to the project owner.
 */
export async function enrollProjectMembersAsSubscribers(input: {
	projectId: string;
	createdByUserId?: string;
}): Promise<{ enrolled: number }> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { id: true, organizationId: true, userId: true },
	});
	if (!project) {
		return { enrolled: 0 };
	}

	let createdByUserId = input.createdByUserId;
	if (!createdByUserId) {
		const s = await db.newsletterSettings.findUnique({
			where: { projectId: input.projectId },
			select: { createdByUserId: true },
		});
		createdByUserId = s?.createdByUserId ?? project.userId ?? undefined;
	}
	if (!createdByUserId) {
		return { enrolled: 0 };
	}

	const members = await getProjectMembers(input.projectId);
	const emails = Array.from(
		new Set(
			members
				.map((m) => m.user?.email?.trim().toLowerCase())
				.filter((e): e is string => !!e),
		),
	);
	if (emails.length === 0) {
		return { enrolled: 0 };
	}

	// XOR tenant fields, identical for every row of this project (mirrors subscribers-add).
	const userId = project.organizationId ? null : project.userId;
	const organizationId = project.organizationId ?? null;

	const res = await db.newsletterSubscriber.createMany({
		data: emails.map((email) => ({
			projectId: input.projectId,
			email,
			name: null,
			userId,
			organizationId,
			status: "ACTIVE",
			unsubscribeToken: generateUnsubscribeToken(),
			createdByUserId: createdByUserId as string,
		})),
		skipDuplicates: true,
	});
	return { enrolled: res.count };
}

export async function removeNewsletterSubscriber(
	projectId: string,
	id: string,
) {
	// Soft opt-out (not delete): leaving a tombstone makes admin removal durable
	// against auto-enrolment reconcile, which create-if-absent would otherwise
	// re-add. Mirrors token unsubscribe (status=UNSUBSCRIBED). Idempotent.
	return db.newsletterSubscriber.updateMany({
		where: { id, projectId },
		data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
	});
}

export async function unsubscribeByToken(token: string): Promise<boolean> {
	const res = await db.newsletterSubscriber.updateMany({
		where: { unsubscribeToken: token, status: "ACTIVE" },
		data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
	});
	return res.count > 0;
}

// Unconfirmed public sign-ups older than this are purged opportunistically on the
// next subscribe write, so anonymous injection can't grow the table unbounded.
const STALE_PENDING_SUBSCRIBER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Public double opt-in: create a PENDING_CONFIRMATION subscriber if-and-only-if
 * (projectId,email) does not already exist. Relies on @@unique([projectId,email])
 * for atomicity — a concurrent double-submit makes the second create throw P2002,
 * mapped to created:false. We deliberately do NOT upsert/update, so an existing
 * ACTIVE/UNSUBSCRIBED/PENDING row is never mutated and a prior opt-out is never
 * resurrected by the anonymous path. `email` MUST be normalized by the caller.
 */
export async function createPendingPublicSubscriber(data: {
	projectId: string;
	email: string;
	userId: string | null;
	organizationId: string | null;
	createdByUserId: string;
}): Promise<{ created: boolean; token: string | null }> {
	// Opportunistic abuse cleanup (mirrors createOrGetNewsletterSend's stale-orphan
	// reclaim): project-scoped, PENDING-only, age-gated → never touches a real
	// (ACTIVE/UNSUBSCRIBED) subscriber.
	await db.newsletterSubscriber.deleteMany({
		where: {
			projectId: data.projectId,
			status: "PENDING_CONFIRMATION",
			createdAt: {
				lt: new Date(Date.now() - STALE_PENDING_SUBSCRIBER_MS),
			},
		},
	});

	const token = generateUnsubscribeToken();
	try {
		await db.newsletterSubscriber.create({
			data: {
				projectId: data.projectId,
				email: data.email,
				userId: data.userId,
				organizationId: data.organizationId,
				createdByUserId: data.createdByUserId,
				unsubscribeToken: token,
				status: "PENDING_CONFIRMATION",
			},
		});
		return { created: true, token };
	} catch (error) {
		// Duck-type the Prisma unique violation (matches notification-service.ts:163)
		// by checking the error shape rather than depending on Prisma's error classes
		// (PrismaClientKnownRequestError).
		if ((error as { code?: string }).code === "P2002") {
			return { created: false, token: null };
		}
		throw error;
	}
}

/**
 * Public double opt-in: confirm a pending subscriber by token. A single
 * conditional updateMany flips PENDING_CONFIRMATION → ACTIVE atomically, so two
 * concurrent confirm clicks result in at most one activation (count === 1) and
 * thus one welcome email. The status guard means a replayed/used token — or one
 * whose row was later UNSUBSCRIBED — is a no-op. `projectId` bounds the token.
 */
export async function confirmPublicSubscriber(
	projectId: string,
	token: string,
): Promise<{ confirmed: boolean; email: string | null }> {
	const { count } = await db.newsletterSubscriber.updateMany({
		where: {
			unsubscribeToken: token,
			projectId,
			status: "PENDING_CONFIRMATION",
		},
		data: { status: "ACTIVE" },
	});
	if (count !== 1) {
		return { confirmed: false, email: null };
	}
	const row = await db.newsletterSubscriber.findFirst({
		where: { unsubscribeToken: token, projectId },
		select: { email: true },
	});
	return { confirmed: true, email: row?.email ?? null };
}

// ---- Embeddable widget: anonymous subscribe + token-gated confirm ----

/**
 * Embed-widget double opt-in: atomically create/refresh a PENDING_CONFIRMATION
 * subscriber for (projectId,email) and report whether a confirmation mail should
 * be sent. There is NO read-then-blind-write: every transition is a single
 * guarded statement, so concurrent submits for the same (projectId,email) yield
 * exactly one `sendEmail:true`.
 *
 * Outcomes:
 *  - ACTIVE / UNSUBSCRIBED row → `{token:null, sendEmail:false}` (never resurrect
 *    an opt-out, never re-mail a confirmed subscriber).
 *  - FRESH PENDING at the CURRENT version → `{token:null, sendEmail:false}`
 *    (send-once: the existing confirm link is still valid).
 *  - PENDING that is null-version / different-version / older than TTL → replace
 *    token + re-stamp version → `{token:new, sendEmail:true}` (old link stale).
 *  - No row → create stamped → `{token:new, sendEmail:true}`.
 *
 * `version` is the project's current `publicEmbedTokenVersion` (resolved from the
 * embed token by the caller). `email` MUST be normalized by the caller.
 */
export async function upsertEmbedPendingSubscriber(data: {
	projectId: string;
	email: string;
	userId: string | null;
	organizationId: string | null;
	createdByUserId: string;
	version: number;
}): Promise<{ token: string | null; sendEmail: boolean }> {
	const token = generateUnsubscribeToken();
	const staleCutoff = new Date(Date.now() - STALE_PENDING_SUBSCRIBER_MS);

	// Intentionally NOT wrapped in a transaction: each statement is individually atomic
	// and the @@unique([projectId,email]) constraint + single-row UPDATE recheck are the
	// real send-once guards — an enclosing tx would add lock/connection time for no
	// integrity gain (a crash between statements leaves only valid resting states).
	// (0) Project-scoped stale purge (mirrors createPendingPublicSubscriber): abandoned
	// anonymous PENDING rows for OTHER emails can't grow the table unbounded via the
	// public widget. Opportunistic + age-gated → never touches ACTIVE/UNSUBSCRIBED/fresh.
	await db.newsletterSubscriber.deleteMany({
		where: {
			projectId: data.projectId,
			status: "PENDING_CONFIRMATION",
			createdAt: { lt: staleCutoff },
		},
	});

	// (1) Atomically replace a REPLACEABLE PENDING row: null/different-version (a
	// rotate/disable made the old link stale) OR older than TTL. A FRESH current-version
	// PENDING matches none → falls to (2) and stays send-once. The (projectId,email)
	// uniqueness means this matches ≤1 row, so two concurrent replacements → one winner
	// (count 1), one miss (count 0).
	const replaced = await db.newsletterSubscriber.updateMany({
		where: {
			projectId: data.projectId,
			email: data.email,
			status: "PENDING_CONFIRMATION",
			OR: [
				{ embedTokenVersion: null },
				{ embedTokenVersion: { not: data.version } },
				{ createdAt: { lt: staleCutoff } },
			],
		},
		data: {
			unsubscribeToken: token,
			embedTokenVersion: data.version,
			// createdAt is re-stamped to refresh the 7-day confirm-link TTL window. NOTE:
			// on a PENDING embed row this means createdAt is "last attempt", NOT "first
			// seen" — do not read it as a birth timestamp for analytics.
			createdAt: new Date(),
		},
	});
	if (replaced.count === 1) {
		return { token, sendEmail: true };
	}

	// (2) No replaceable row → try create. P2002 means a row already exists (ACTIVE /
	// UNSUBSCRIBED / FRESH current-version PENDING) → no-op (send-once).
	try {
		await db.newsletterSubscriber.create({
			data: {
				projectId: data.projectId,
				email: data.email,
				userId: data.userId,
				organizationId: data.organizationId,
				createdByUserId: data.createdByUserId,
				unsubscribeToken: token,
				status: "PENDING_CONFIRMATION",
				embedTokenVersion: data.version,
			},
		});
		return { token, sendEmail: true };
	} catch (error) {
		// Duck-type the Prisma unique violation (matches createPendingPublicSubscriber)
		// by checking the error shape rather than depending on Prisma's error classes
		// (PrismaClientKnownRequestError).
		const e = error as { code?: string; meta?: { target?: unknown } };
		if (e.code === "P2002") {
			// A P2002 here is normally the @@unique([projectId, email]) row already
			// existing (ACTIVE / UNSUBSCRIBED / fresh current-version PENDING) → send-once
			// no-op. Only the GLOBAL unsubscribeToken @unique collision must NOT be
			// swallowed (it would silently drop a first-subscribe). Rethrow only when the
			// target positively names the token column; otherwise default to the no-op
			// (adapter-pg may not populate meta.target → keep current behavior).
			const target = e.meta?.target;
			const hay = Array.isArray(target)
				? target.join(",")
				: String(target ?? "");
			if (hay.includes("unsubscribeToken")) {
				throw error;
			}
			return { token: null, sendEmail: false };
		}
		throw error;
	}
}

/**
 * Embed-widget double opt-in confirm. Resolves the subscriber by token and
 * activates it, with a revocation gate for embed-originated rows:
 *  - `embedTokenVersion === null` (marketing/legacy/pre-migration) → activate with
 *    NO widget gate (back-compat).
 *  - `embedTokenVersion` set → activate ONLY when the project's widget is still
 *    enabled AND the version still matches `publicEmbedTokenVersion`.
 *
 * Runs entirely in one transaction. For a stamped row it takes the settings row's
 * `SELECT … FOR UPDATE` lock — the SAME lock the owner's disable/rotate takes — so
 * the gate read serializes against an in-flight revocation and sees committed
 * state (no stale activation under READ COMMITTED). The activation is itself a
 * status-guarded `updateMany`, so a racing second confirm gets count 0 → exactly
 * one welcome email. No read-then-blind-write at any step.
 *
 * Returns the owning `projectId` on a successful activation so callers can apply
 * per-project side effects (e.g. forwarding a Fabric-main opt-in to GTM Brain)
 * WITHOUT re-resolving the token through an ungated project-scoped lookup.
 */
export async function confirmPublicSubscriberByToken(token: string): Promise<{
	confirmed: boolean;
	email: string | null;
	projectId: string | null;
}> {
	return db.$transaction(async (tx) => {
		const sub = await tx.newsletterSubscriber.findFirst({
			where: { unsubscribeToken: token, status: "PENDING_CONFIRMATION" },
			select: {
				id: true,
				email: true,
				projectId: true,
				embedTokenVersion: true,
			},
		});
		if (!sub) {
			return { confirmed: false, email: null, projectId: null };
		}

		if (sub.embedTokenVersion !== null) {
			// LOCK the settings row → blocks on an in-flight disable/rotate, then reads
			// COMMITTED gate state (no stale activation). Same lock the owner toggle takes.
			const locked = await tx.$queryRaw<
				Array<{
					publicWidgetEnabled: boolean;
					publicEmbedTokenVersion: number;
				}>
			>`
				SELECT "publicWidgetEnabled", "publicEmbedTokenVersion"
				FROM "newsletter_settings" WHERE "projectId" = ${sub.projectId} FOR UPDATE`;
			const s = locked[0];
			if (
				!s ||
				!s.publicWidgetEnabled ||
				s.publicEmbedTokenVersion !== sub.embedTokenVersion
			) {
				return { confirmed: false, email: null, projectId: null };
			}
		}

		// Guarded activation: status=PENDING in WHERE → a racing second confirm blocks on
		// the row lock, re-evaluates, gets count 0 (already ACTIVE) → one welcome email only.
		// The WHERE also re-checks the still-current bearer token + stamped version: under
		// READ COMMITTED a concurrent resubscribe (upsertEmbedPendingSubscriber) can replace
		// this row's unsubscribeToken/embedTokenVersion between the findFirst read and this
		// update, so pinning both ensures ONLY the still-current token can activate (an
		// OLD/superseded token matches 0 rows). `unsubscribeToken` is globally @unique and
		// changes on every replacement; `embedTokenVersion: sub.embedTokenVersion` correctly
		// handles null-stamp legacy rows (Prisma treats `null` as IS NULL → matches the row).
		const upd = await tx.newsletterSubscriber.updateMany({
			where: {
				id: sub.id,
				status: "PENDING_CONFIRMATION",
				unsubscribeToken: token,
				embedTokenVersion: sub.embedTokenVersion,
			},
			data: { status: "ACTIVE" },
		});
		return upd.count === 1
			? { confirmed: true, email: sub.email, projectId: sub.projectId }
			: { confirmed: false, email: null, projectId: null };
	});
}

// ---- Sends ----
export const SEND_STATUS_GROUP: Record<string, string[]> = {
	sent: ["SENT", "PARTIAL"],
	failed: ["FAILED"],
	skipped: ["SKIPPED_EMPTY"],
};

function sendsWhere(projectId: string, status?: string) {
	const statuses =
		status && status !== "all" ? SEND_STATUS_GROUP[status] : undefined;
	return { projectId, ...(statuses ? { status: { in: statuses } } : {}) };
}

/** Exported for unit testing the args shape without a DB. */
export function buildSendsListArgs(
	projectId: string,
	{
		limit = 15,
		offset = 0,
		status,
	}: { limit?: number; offset?: number; status?: string },
) {
	return {
		where: sendsWhere(projectId, status),
		// Member-safe projection (Codex §5): admin history table consumes only these
		// columns. Dropping the rest stops `sends.list` (callable by viewers via
		// PROJECT_SETTINGS_READ) from leaking aiUsageTokens / temporalWorkflowId /
		// triggeredByUserId / errorMessage / dedupeKey / content to read-only members.
		select: {
			id: true,
			status: true,
			skipReason: true,
			createdAt: true,
			trigger: true,
			sentCount: true,
			recipientCount: true,
			failedCount: true,
			// Non-sensitive: it is the project's own Distribution setting,
			// already rendered in the form above this table. Needed so the
			// history row knows whether a chat detail panel exists at all
			// (Fizzy #2013). The exclusions listed above still stand.
			deliveryDestination: true,
			// Same reasoning: the project's own Approval setting, rendered in
			// the same form. The badge needs it to tell "being curated for
			// review" apart from "being sent" — PENDING is the pre-review state
			// on a gated project (Fizzy #2172).
			requireApproval: true,
		},
		// id tiebreak: createdAt is not unique; without it tied rows shift across pages.
		orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
		take: limit,
		skip: offset,
	};
}

export async function listNewsletterSends(
	projectId: string,
	opts: { limit?: number; offset?: number; status?: string } = {},
) {
	return db.newsletterSend.findMany(buildSendsListArgs(projectId, opts));
}

export async function countNewsletterSends(projectId: string, status?: string) {
	return db.newsletterSend.count({ where: sendsWhere(projectId, status) });
}

// In-app member Release Notes: completed notes (SENT/PARTIAL, content present) plus
// PENDING (content null) rendered as a "being prepared" row. Excludes SKIPPED_EMPTY/FAILED.
const MEMBER_VISIBLE_SEND_STATUSES = ["SENT", "PARTIAL", "PENDING"] as const;

/** Exported for unit testing the args shape without a DB. */
export function buildMemberSendsListArgs(
	projectId: string,
	{ limit = 15, offset = 0 }: { limit?: number; offset?: number },
) {
	return {
		where: { projectId, status: { in: [...MEMBER_VISIBLE_SEND_STATUSES] } },
		// member-safe projection — NO aiUsageTokens / temporalWorkflowId /
		// triggeredByUserId / errorMessage / dedupeKey. content is included because
		// the in-app detail modal renders it.
		select: { id: true, status: true, createdAt: true, content: true },
		orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
		take: limit,
		skip: offset,
	};
}

export async function listNewsletterSendsForMembers(
	projectId: string,
	opts: { limit?: number; offset?: number } = {},
) {
	return db.newsletterSend.findMany(
		buildMemberSendsListArgs(projectId, opts),
	);
}

export async function countNewsletterSendsForMembers(projectId: string) {
	return db.newsletterSend.count({
		where: { projectId, status: { in: [...MEMBER_VISIBLE_SEND_STATUSES] } },
	});
}

// Public release-notes archive (fabric.pro /release-notes): ONLY published sends
// (SENT/PARTIAL) — PENDING/FAILED/SKIPPED_EMPTY never leak to unauthenticated
// visitors. Every query is project-bounded: projectId is the security bound, set
// server-side from FABRIC_MAIN_PROJECT_ID, never from client input.
const PUBLIC_ARCHIVE_STATUSES = ["SENT", "PARTIAL"] as const;

/** Exported for unit testing the args shape without a DB. */
export function buildPublicArchiveListArgs(
	projectId: string,
	{ limit = 15, offset = 0 }: { limit?: number; offset?: number },
) {
	return {
		where: { projectId, status: { in: [...PUBLIC_ARCHIVE_STATUSES] } },
		// public-safe projection — NO aiUsageTokens / temporalWorkflowId /
		// triggeredByUserId / errorMessage / dedupeKey / tenant ids. content is
		// included because the public pages render the release note body.
		select: { id: true, status: true, createdAt: true, content: true },
		orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
		take: limit,
		skip: offset,
	};
}

export async function listPublicNewsletterArchive(
	projectId: string,
	opts: { limit?: number; offset?: number } = {},
) {
	return db.newsletterSend.findMany(
		buildPublicArchiveListArgs(projectId, opts),
	);
}

export async function countPublicNewsletterArchive(projectId: string) {
	return db.newsletterSend.count({
		where: { projectId, status: { in: [...PUBLIC_ARCHIVE_STATUSES] } },
	});
}

export async function getPublicNewsletterArchiveItem(
	projectId: string,
	sendId: string,
) {
	// projectId in the where-clause is the cross-project guard: a crafted sendId
	// from another project returns null (→ 404), never the row.
	return db.newsletterSend.findFirst({
		where: {
			id: sendId,
			projectId,
			status: { in: [...PUBLIC_ARCHIVE_STATUSES] },
		},
		select: { id: true, status: true, createdAt: true, content: true },
	});
}

export async function findRecentNonFailedSend(
	projectId: string,
	sinceMs: number,
) {
	return db.newsletterSend.findFirst({
		where: {
			projectId,
			createdAt: { gt: new Date(Date.now() - sinceMs) },
			status: { not: "FAILED" },
		},
		select: { id: true, createdAt: true },
	});
}

export type CreateNewsletterSendInput = {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	dedupeKey: string;
	trigger: "MANUAL" | "SCHEDULED";
	timeWindowStart: Date;
	timeWindowEnd: Date;
	triggeredByUserId: string | null;
	detailLevel: NewsletterDetailLevel;
	// OPTIONAL (P1): callers are updated to pass this explicitly in a later task
	// (chat-delivery rollout). Making it required here would compile-break every
	// intermediate task between this one and that caller update.
	deliveryDestination?: NewsletterDeliveryDestination;
	// OPTIONAL: frozen onto the send row at creation (Fizzy 1869 approval gate)
	// so a retry/read-back never re-reads live (possibly since-changed) settings.
	requireApproval?: boolean;
	chatChannels?: NewsletterChatChannel[];
};

/**
 * Pure builder for the `create({ data })` payload of `createOrGetNewsletterSend`.
 * Extracted so the requireApproval/chatChannels defaulting (and the rest of
 * the frozen-at-creation shape) is unit-testable without a live DB.
 */
export function buildCreateSendData(input: CreateNewsletterSendInput) {
	return {
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		dedupeKey: input.dedupeKey,
		status: "PENDING" as const,
		trigger: input.trigger,
		timeWindowStart: input.timeWindowStart,
		timeWindowEnd: input.timeWindowEnd,
		triggeredByUserId: input.triggeredByUserId,
		detailLevel: input.detailLevel,
		deliveryDestination: input.deliveryDestination ?? "EMAIL",
		requireApproval: input.requireApproval ?? false,
		chatChannels: (input.chatChannels ?? []) as object,
	};
}

/**
 * Idempotent send creation. Returns the row and whether it was newly created.
 * Honors BOTH the dedupeKey @unique and the (projectId) WHERE status='PENDING'
 * partial index: any unique violation reads back the active/matching row.
 */
export async function createOrGetNewsletterSend(
	input: CreateNewsletterSendInput,
): Promise<{
	send: {
		id: string;
		status: string;
		temporalWorkflowId: string | null;
		detailLevel: string | null;
		deliveryDestination: string | null;
		requireApproval: boolean;
		chatChannels: unknown;
	};
	created: boolean;
}> {
	// Safe orphan reclaim: free stale PENDING rows that PROVABLY have no live
	// workflow and never sent anything (deliveries: { none: {} }), so their
	// (projectId) WHERE status='PENDING' partial index + dedupeKey stop blocking
	// the project's future sends. This unblocks a manual send whose workflow
	// died/timed out (e.g. a temporal-worker outage): it has no restart path, so
	// the previous `temporalWorkflowId: null`-only reclaim stranded it forever.
	//
	// Threshold = 30m = 2× the 15m workflowExecutionTimeout, keyed on createdAt,
	// applied to EVERY PENDING row regardless of temporalWorkflowId. Three facts,
	// all surfaced by adversarial review, force the 2× margin and the age-only gate:
	//   1. A workflow (if one was started) begins at ~createdAt + δ — workflow.start
	//      runs AFTER this row is created — and Temporal force-closes it at
	//      start + 15m (server-enforced). Its latest possible close is
	//      createdAt + δ + 15m, NOT createdAt + 15m. 30m clears δ + 15m for any
	//      realistic start delay or app/DB/Temporal clock skew.
	//   2. temporalWorkflowId == null is NOT proof the workflow never started:
	//      both start paths persist the id only AFTER a successful workflow.start
	//      and SWALLOW a persist failure (the workflow is alive and self-finalizes).
	//      So a null id can mean "running, id not persisted." The 30m bound holds
	//      whether or not the id was persisted, so we gate on age alone.
	//   3. δ (the create→start gap) is itself bounded well under 30m by the
	//      callers' own timeouts: sendNow starts the workflow inline in the oRPC
	//      request (sub-second), and dispatchNewsletterSendActivity runs under a
	//      1-minute startToCloseTimeout. So a >30m-old row cannot still have a
	//      pending workflow.start. The only way to violate this is a multi-minute
	//      process freeze BETWEEN row creation and workflow.start; even then the
	//      guards below make it harmless (the resumed workflow's claim/finalize
	//      fails on the deleted row — no mail, no evidence loss), so we accept the
	//      age heuristic rather than add a Temporal describe call or a lease column.
	// `deliveries: { none: {} }` guarantees nothing was claimed/sent, so reclaim
	// can neither cascade away delivery evidence nor cause a double-mail (and the
	// NewsletterDelivery FK fails any post-delete claim). Scheduled recovery is
	// unaffected: the dispatcher's restart-same-id model only matters when
	// deliveries exist — with none there is nothing to preserve.
	const STALE_PENDING_MS = 30 * 60 * 1000; // 2× workflowExecutionTimeout (15m)
	await db.newsletterSend.deleteMany({
		where: {
			projectId: input.projectId,
			status: "PENDING",
			deliveries: { none: {} },
			createdAt: { lt: new Date(Date.now() - STALE_PENDING_MS) },
		},
	});

	try {
		const send = await db.newsletterSend.create({
			data: buildCreateSendData(input),
			select: {
				id: true,
				status: true,
				temporalWorkflowId: true,
				detailLevel: true,
				deliveryDestination: true,
				requireApproval: true,
				chatChannels: true,
			},
		});
		return { send, created: true };
	} catch (error) {
		// Unique violation: either the dedupeKey already exists OR the project
		// already has a PENDING send (partial index). Read back the live row.
		const existing =
			(await db.newsletterSend.findUnique({
				where: { dedupeKey: input.dedupeKey },
				select: {
					id: true,
					status: true,
					temporalWorkflowId: true,
					detailLevel: true,
					deliveryDestination: true,
					requireApproval: true,
					chatChannels: true,
				},
			})) ??
			(await db.newsletterSend.findFirst({
				where: {
					projectId: input.projectId,
					status: { in: ["PENDING", "PENDING_APPROVAL", "APPROVED"] },
				},
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					status: true,
					temporalWorkflowId: true,
					detailLevel: true,
					deliveryDestination: true,
					requireApproval: true,
					chatChannels: true,
				},
			}));
		if (existing) {
			return { send: existing, created: false };
		}
		// No row to read back: the failure was not a unique violation (e.g. a
		// transient connection error during create). Rethrow the original error
		// so the real cause is not masked.
		throw error;
	}
}

export async function setNewsletterSendWorkflowId(
	sendId: string,
	workflowId: string,
) {
	return db.newsletterSend.update({
		where: { id: sendId },
		data: { temporalWorkflowId: workflowId },
	});
}

// ---- Approval gate (Fizzy 1869): hold / approve / reject / expire / read ----

/** Generate-phase park: persist curated content and move the row to
 *  PENDING_APPROVAL. Conditional on the row still being PENDING so a concurrent
 *  reclaim/other transition can't be clobbered. */
export async function holdNewsletterForApproval(input: {
	sendId: string;
	content: NewsletterContent;
	aiUsageTokens: number | null;
}): Promise<void> {
	await db.newsletterSend.updateMany({
		where: { id: input.sendId, status: "PENDING" },
		data: {
			status: "PENDING_APPROVAL",
			content: input.content as object,
			aiUsageTokens: input.aiUsageTokens ?? null,
		},
	});
}

interface ReviewAuditActor {
	reviewedByUserId: string;
	actorEmail?: string | null;
	actorName?: string | null;
	organizationId: string | null;
	projectId: string;
}

/** Atomic PENDING_APPROVAL → APPROVED + audit, in one tx. count===0 ⇒ not
 *  approvable (already acted / wrong status). This transition closes the
 *  approve/reject race: reject/expire are conditional on PENDING_APPROVAL, so once
 *  APPROVED nothing else can move the row. */
export async function approveNewsletterSend(input: {
	sendId: string;
	removedHighlightIndexes: number[];
	audit: ReviewAuditActor;
}): Promise<{ approved: boolean }> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.newsletterSend.updateMany({
			where: { id: input.sendId, status: "PENDING_APPROVAL" },
			data: {
				status: "APPROVED",
				reviewedByUserId: input.audit.reviewedByUserId,
				reviewedAt: new Date(),
				removedHighlightIndexes:
					input.removedHighlightIndexes as object,
			},
		});
		if (count > 0) {
			await recordAuditTx(tx, {
				action: "newsletter.send.approved",
				actor: {
					type: "user",
					userId: input.audit.reviewedByUserId,
					emailSnapshot: input.audit.actorEmail ?? null,
					nameSnapshot: input.audit.actorName ?? null,
				},
				organizationId: input.audit.organizationId,
				projectId: input.audit.projectId,
				resource: { type: "newsletter_send", id: input.sendId },
				metadata: {
					removedCount: input.removedHighlightIndexes.length,
				},
			});
		}
		return { approved: count > 0 };
	});
}

/** Atomic PENDING_APPROVAL → REJECTED + audit, in one tx. Does NOT advance lastSentAt. */
export async function rejectNewsletterSend(input: {
	sendId: string;
	reason?: string | null;
	audit: ReviewAuditActor;
}): Promise<{ rejected: boolean }> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.newsletterSend.updateMany({
			where: { id: input.sendId, status: "PENDING_APPROVAL" },
			data: {
				status: "REJECTED",
				reviewedByUserId: input.audit.reviewedByUserId,
				reviewedAt: new Date(),
				rejectionReason: input.reason ?? null,
				completedAt: new Date(),
			},
		});
		if (count > 0) {
			await recordAuditTx(tx, {
				action: "newsletter.send.rejected",
				actor: {
					type: "user",
					userId: input.audit.reviewedByUserId,
					emailSnapshot: input.audit.actorEmail ?? null,
					nameSnapshot: input.audit.actorName ?? null,
				},
				organizationId: input.audit.organizationId,
				projectId: input.audit.projectId,
				resource: { type: "newsletter_send", id: input.sendId },
				metadata: { reason: input.reason ?? null },
			});
		}
		return { rejected: count > 0 };
	});
}

/**
 * Frees the active-send slot for a project by terminalizing a stale
 * held-or-approved send: a `PENDING_APPROVAL` draft older than
 * `STALE_APPROVAL_TTL_MS` → `EXPIRED` (abandoned review, Codex finding 2); an
 * `APPROVED` row older than `STALE_APPROVED_MS` → `FAILED` (its send workflow
 * was hard-killed/timed-out before its outer catch could finalize — Codex
 * final-review backstop). Both are conditional `updateMany` so a
 * concurrently-progressing row is never clobbered; neither advances
 * `lastSentAt`.
 */
export async function reclaimStaleReviewSends(
	projectId: string,
): Promise<{ expiredDraftId: string | null; failedApprovedId: string | null }> {
	const now = Date.now();
	let expiredDraftId: string | null = null;
	let failedApprovedId: string | null = null;

	const staleDraft = await db.newsletterSend.findFirst({
		where: {
			projectId,
			status: "PENDING_APPROVAL",
			createdAt: { lt: new Date(now - STALE_APPROVAL_TTL_MS) },
		},
		select: { id: true },
	});
	if (staleDraft) {
		const { count } = await db.newsletterSend.updateMany({
			where: { id: staleDraft.id, status: "PENDING_APPROVAL" },
			data: { status: "EXPIRED", completedAt: new Date() },
		});
		if (count > 0) {
			expiredDraftId = staleDraft.id;
		}
	}

	// Staleness measured from reviewedAt (set at PENDING_APPROVAL → APPROVED), NOT
	// createdAt: a draft can sit in review for days before approval, so createdAt
	// would make a freshly-approved live send instantly reclaim-eligible (Codex
	// final-review). reviewedAt ≈ approval time, so a live send (≤15m) is safe.
	const deadApproved = await db.newsletterSend.findFirst({
		where: {
			projectId,
			status: "APPROVED",
			reviewedAt: { lt: new Date(now - STALE_APPROVED_MS) },
		},
		select: { id: true },
	});
	if (deadApproved) {
		const { count } = await db.newsletterSend.updateMany({
			where: { id: deadApproved.id, status: "APPROVED" },
			data: {
				status: "FAILED",
				errorMessage: "Send workflow did not finalize before timeout",
				completedAt: new Date(),
			},
		});
		if (count > 0) {
			failedApprovedId = deadApproved.id;
		}
	}

	return { expiredDraftId, failedApprovedId };
}

/** Send-phase read: everything the approved send needs, straight off the frozen
 *  row (never live settings/client input — Codex finding 3). */
export async function getNewsletterSendForSendPhase(sendId: string) {
	return db.newsletterSend.findUnique({
		where: { id: sendId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			status: true,
			content: true,
			deliveryDestination: true,
			chatChannels: true,
			removedHighlightIndexes: true,
			timeWindowEnd: true,
		},
	});
}

/**
 * Just the status, for callers re-reading it in a loop.
 *
 * `getNewsletterSendForSendPhase` above selects `content` — the whole curated
 * newsletter JSON — plus `chatChannels` and `removedHighlightIndexes`. That is
 * right for the one read that sets up a send, and wrong for a liveness check
 * run once PER TARGET: the chat fan-out re-reads the status for each channel it
 * is about to post to, up to the schema's 50-channel cap and concurrently, so
 * reusing the wide query drags the payload 50 times over to compare one string
 * (Fizzy #2203).
 */
export async function getNewsletterSendStatus(
	sendId: string,
): Promise<string | null> {
	const row = await db.newsletterSend.findUnique({
		where: { id: sendId },
		select: { status: true },
	});
	return row?.status ?? null;
}

/** Reviewer inbox: held drafts (PENDING_APPROVAL) AND in-flight approved
 *  (APPROVED) sends, newest first. APPROVED rows are surfaced so a send stranded
 *  by a Temporal-start failure (Codex plan-review finding 1) is visible and can
 *  be re-kicked via the idempotent approve path. `status` lets the UI render
 *  APPROVED as "Sending…" with a Retry action instead of review controls. */
export async function listPendingApprovalSends(projectId: string) {
	return db.newsletterSend.findMany({
		where: { projectId, status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: {
			id: true,
			status: true,
			createdAt: true,
			content: true,
			timeWindowStart: true,
			timeWindowEnd: true,
			deliveryDestination: true,
		},
	});
}

export async function finalizeNewsletterSend(input: {
	sendId: string;
	status: "SENT" | "PARTIAL" | "FAILED" | "SKIPPED_EMPTY";
	skipReason?: NewsletterSkipReason | null;
	recipientCount?: number;
	sentCount?: number;
	failedCount?: number;
	content?: unknown;
	aiUsageTokens?: number | null;
	errorMessage?: string | null;
	// Guarded finalize (Fizzy 1869): when set, the update is conditional on the
	// row still being in this status, so a raced/superseded row (e.g. reclaimed
	// to FAILED by `reclaimStaleReviewSends`, or already finalized by a
	// concurrent retry) is never clobbered. Omitted ⇒ the unconditional legacy
	// update (existing callers), which always "finalizes".
	expectStatus?: NewsletterSendStatus;
}): Promise<{ finalized: boolean }> {
	const data = {
		status: input.status,
		skipReason: input.skipReason ?? null,
		recipientCount: input.recipientCount ?? 0,
		sentCount: input.sentCount ?? 0,
		failedCount: input.failedCount ?? 0,
		content: (input.content as object | undefined) ?? undefined,
		aiUsageTokens: input.aiUsageTokens ?? null,
		errorMessage: input.errorMessage ?? null,
		completedAt: new Date(),
	};
	if (input.expectStatus) {
		const { count } = await db.newsletterSend.updateMany({
			where: { id: input.sendId, status: input.expectStatus },
			data,
		});
		return { finalized: count > 0 };
	}
	await db.newsletterSend.update({ where: { id: input.sendId }, data });
	return { finalized: true };
}

// ---- Deliveries (per-recipient idempotency) ----
export async function claimDelivery(input: {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	recipientEmail: string;
}): Promise<{ alreadySent: boolean }> {
	const existing = await db.newsletterDelivery.findUnique({
		where: {
			sendId_recipientEmail: {
				sendId: input.sendId,
				recipientEmail: input.recipientEmail,
			},
		},
		select: { status: true },
	});
	if (existing?.status === "SENT") {
		return { alreadySent: true };
	}

	await db.newsletterDelivery.upsert({
		where: {
			sendId_recipientEmail: {
				sendId: input.sendId,
				recipientEmail: input.recipientEmail,
			},
		},
		create: {
			sendId: input.sendId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			recipientEmail: input.recipientEmail,
			status: "SENDING",
			attemptCount: 1,
		},
		update: { status: "SENDING", attemptCount: { increment: 1 } },
	});
	return { alreadySent: false };
}

export async function markDelivery(
	sendId: string,
	recipientEmail: string,
	status: "SENT" | "FAILED",
	errorMessage?: string,
) {
	return db.newsletterDelivery.update({
		where: { sendId_recipientEmail: { sendId, recipientEmail } },
		data: {
			status,
			errorMessage: errorMessage ?? null,
			sentAt: status === "SENT" ? new Date() : null,
		},
	});
}

// ---- Chat deliveries (per-channel idempotency, chat analog of the email ledger) ----
export async function claimChatDelivery(input: {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	kind: NewsletterChatDeliveryKind;
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
}): Promise<{ claimed: boolean }> {
	// Fail-closed: the INSERT is the ONLY dedup gate — there is no separate
	// pre-check, the write itself is the gate. The caller MUST NOT post on a
	// refused claim (chat posts are not idempotent).
	//
	// ONE unique index guards this insert —
	// `(sendId, kind, platform, externalTeamId, channelId)` — so a P2002 has a
	// single meaning: this exact (send, kind, channel) was already handled by a
	// prior attempt. Returning claimed:false is correct and the caller skips.
	//
	// It had two meanings for one release. A narrower key kept as a rollback
	// fence also refused the OTHER kind's row for the same channel, and
	// `deliverOne` turns claimed:false into SKIPPED without writing a row — so
	// a refused delivery vanished from the ledger instead of surfacing as a
	// skip with a reason. That index is gone
	// (20260820190000_newsletter_chat_delivery_drop_legacy_fence, Fizzy #2203).
	//
	// Do NOT reintroduce a predicate over the violated constraint to tell cases
	// apart. It cannot work on this stack: Prisma's documented home for the
	// constraint, `meta.target`, is `undefined` for every P2002 on Prisma 6.18 +
	// the Postgres driver adapter — measured, and the same note sits on this
	// file's other P2002 handler. A version of this that logged on that basis
	// fired on every retry of the shipped content path. `deliverChatMessages`
	// asks the ledger what is actually there instead, which is invariant to all
	// of it. `chat-delivery-kind.integration.test.ts` pins both facts.
	try {
		await db.newsletterChatDelivery.create({
			data: {
				sendId: input.sendId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				kind: input.kind,
				platform: input.platform,
				externalTeamId: input.externalTeamId,
				channelId: input.channelId,
				status: "SENDING",
			},
		});
		return { claimed: true };
	} catch (e) {
		if ((e as { code?: string }).code === "P2002") {
			return { claimed: false };
		}
		throw e;
	}
}

export async function markChatDelivery(input: {
	sendId: string;
	kind: NewsletterChatDeliveryKind;
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
	status: "SENT" | "FAILED" | "SKIPPED";
	errorMessage?: string;
	postedMessageId?: string;
}): Promise<void> {
	await db.newsletterChatDelivery.updateMany({
		// `kind` is part of the match, not just the payload: an APPROVAL row and
		// a CONTENT row can share (sendId, platform, externalTeamId, channelId)
		// — the normal case once an alerted channel also receives the approved
		// notes — and a kind-less where would mark BOTH, cross-contaminating the
		// send's recorded delivery outcome (Fizzy #2203).
		where: {
			sendId: input.sendId,
			kind: input.kind,
			platform: input.platform,
			externalTeamId: input.externalTeamId,
			channelId: input.channelId,
		},
		data: {
			status: input.status,
			errorMessage: input.errorMessage ?? null,
			postedMessageId: input.postedMessageId ?? null,
			deliveredAt: input.status === "SENT" ? new Date() : null,
		},
	});
}

/**
 * Activity-facing ledger read-back for ONE delivery kind.
 *
 * `kind` is required because the caller uses these rows to compute the send's
 * sentCount/failedCount, which decides SENT vs PARTIAL vs FAILED. Counting the
 * other kind's rows would change a send's recorded verdict (Fizzy #2203).
 */
export async function listChatDeliveriesForSend(
	sendId: string,
	kind: NewsletterChatDeliveryKind,
) {
	return db.newsletterChatDelivery.findMany({
		where: { sendId, kind },
		select: {
			platform: true,
			externalTeamId: true,
			channelId: true,
			status: true,
			errorMessage: true,
			postedMessageId: true,
			deliveredAt: true,
		},
	});
}

/**
 * Project-scoped variant of `listChatDeliveriesForSend` for API callers.
 *
 * The activity-facing version takes only `sendId` because a Temporal activity
 * already resolved the tenant. An API caller has an untrusted `sendId`, so the
 * `projectId` bound is mandatory: without it, any authenticated user could read
 * another project's delivery ledger by guessing a send id.
 */
export async function listChatDeliveriesForProjectSend(
	sendId: string,
	projectId: string,
) {
	return db.newsletterChatDelivery.findMany({
		where: { sendId, projectId },
		select: {
			kind: true,
			platform: true,
			externalTeamId: true,
			channelId: true,
			status: true,
			errorMessage: true,
		},
		// Sort on the ledger's FULL identity. A channel id is unique only within
		// a workspace/team, so ordering by platform+channelId alone leaves two
		// rows that differ only by externalTeamId in unspecified order — the
		// panel would reshuffle them between refetches for no visible reason.
		// `kind` joined that identity in Fizzy #2203 and so joins this sort. It
		// goes LAST so the channel-major grouping above is byte-identical and
		// only the tie is broken. That tie is now reachable: the contract
		// release dropped the legacy single-channel index, so a CONTENT row and
		// an APPROVAL row can share a channel tuple on one send.
		orderBy: [
			{ platform: "asc" },
			{ externalTeamId: "asc" },
			{ channelId: "asc" },
			{ kind: "asc" },
		],
	});
}

/**
 * Display names for a project's linked chat channels, keyed for the delivery
 * ledger's composite identity (`platform:externalTeamId:channelId`).
 *
 * Deliberately NOT `getLinkedTeamsChannels` / `getLinkedSlackChannels`: those
 * are the monitor-facing readers and each carries an aggregate
 * `_count: { seenMessages: true }`, so reusing them would run a COUNT over the
 * seen-message table for every linked channel every time an admin expands one
 * history row — to read a single nullable string.
 *
 * `channelName` is nullable on both models, so an unnamed row is simply omitted
 * and the caller falls back to the raw channel id.
 */
export async function getLinkedChannelNames(
	projectId: string,
): Promise<Map<string, string>> {
	const [teams, slack] = await Promise.all([
		db.projectLinkedTeamsChannel.findMany({
			where: { projectId },
			select: { teamId: true, channelId: true, channelName: true },
		}),
		db.projectLinkedSlackChannel.findMany({
			where: { projectId },
			select: { slackTeamId: true, channelId: true, channelName: true },
		}),
	]);

	const names = new Map<string, string>();
	for (const c of teams) {
		if (c.channelName) {
			names.set(`TEAMS:${c.teamId}:${c.channelId}`, c.channelName);
		}
	}
	for (const c of slack) {
		if (c.channelName) {
			names.set(`SLACK:${c.slackTeamId}:${c.channelId}`, c.channelName);
		}
	}
	return names;
}
