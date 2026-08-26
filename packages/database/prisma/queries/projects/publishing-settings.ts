/**
 * Publishing Suite per-project settings (Phase 1C-1).
 *
 * Uses the raw `db` client (BYPASSRLS); tenant columns are derived HERE from the
 * parent Project, never taken from caller input.
 *
 * The write locks the Project row `FOR UPDATE` inside a transaction. The
 * newsletter settings upsert this is otherwise modelled on does NOT, which
 * leaves a project-transfer TOCTOU: a transfer landing between the tenant read
 * and the upsert stamps the OLD tuple onto a row that now belongs to a different
 * tenant. Publishing already hit and fixed this exact race in
 * `createManualPublishingTopic` (see its C-High note); this follows that path.
 */
import type { PublishingTopicPostType } from "../../generated/client";
import type { PublishingCadence } from "../../../src/publishing-cadence";
import { DEFAULT_PUBLISHING_CADENCE } from "../../../src/publishing-cadence";
import type { PublishingChatChannel } from "../../../src/publishing-chat-channel";
import { db } from "../../client";

/** The project row vanished between authorization and the locked read. */
export class PublishingSettingsProjectNotFoundError extends Error {
	constructor(readonly projectId: string) {
		super(`Project ${projectId} not found`);
		this.name = "PublishingSettingsProjectNotFoundError";
	}
}

/** A positively-wrong non-null client organizationId. */
export class PublishingSettingsTenantMismatchError extends Error {
	constructor(readonly projectId: string) {
		super(`organizationId does not match project ${projectId}`);
		this.name = "PublishingSettingsTenantMismatchError";
	}
}

/**
 * Non-tenant columns safe to hand back to a caller. `organizationId`,
 * `userId` and `createdByUserId` are internal tenant-derivation columns and
 * must never appear in a read OR write response — both paths select through
 * this one constant so their shapes cannot drift apart.
 */
const PUBLISHING_SUITE_SETTINGS_PUBLIC_SELECT = {
	id: true,
	projectId: true,
	cadence: true,
	lookbackDays: true,
	notificationsEnabled: true,
	chatChannels: true,
	preferredThemes: true,
	preferredPostTypes: true,
	strategicPriorities: true,
	createdAt: true,
	updatedAt: true,
} as const;

/**
 * The synthetic row returned when a project has no settings row. Viewing never
 * writes one — matching `getNewsletterSettings`.
 */
export function publishingSuiteSettingsDefaults(projectId: string) {
	return {
		id: null as string | null,
		projectId,
		cadence: DEFAULT_PUBLISHING_CADENCE as string,
		lookbackDays: null as number | null,
		notificationsEnabled: true,
		chatChannels: null as PublishingChatChannel[] | null,
		// Empty, not null — these mirror the columns' own `@default([])`, so a
		// project with no settings row and a project that has one but configured
		// nothing produce the SAME preferences snapshot, and therefore the same
		// fingerprint. Returning null here would make "never configured" and
		// "configured then cleared" hash differently and buy one of them a
		// reprocessing run it did not earn.
		preferredThemes: [] as string[],
		preferredPostTypes: [] as PublishingTopicPostType[],
		strategicPriorities: null as string | null,
		createdAt: null as Date | null,
		updatedAt: null as Date | null,
	};
}

export async function getPublishingSuiteSettings(projectId: string) {
	const s = await db.publishingSuiteSettings.findUnique({
		where: { projectId },
		select: PUBLISHING_SUITE_SETTINGS_PUBLIC_SELECT,
	});
	return s ?? publishingSuiteSettingsDefaults(projectId);
}

export interface UpsertPublishingSuiteSettingsInput {
	projectId: string;
	/** F2 guard ONLY — never stamped. null/omitted always passes. */
	clientOrganizationId: string | null;
	/** The acting admin. Not a tenant column; re-homed on every save. */
	createdByUserId: string;
	cadence?: PublishingCadence;
	lookbackDays?: number | null;
	notificationsEnabled?: boolean;
	/**
	 * The selected broadcast targets. Omitted leaves the stored list untouched;
	 * `[]` is the OFF switch and must reach the column as an empty array, not be
	 * folded back into "unchanged".
	 *
	 * NOT nullable, unlike `lookbackDays`. There is nothing for a null to mean
	 * here that `[]` does not already mean, so accepting one would add a write
	 * path (Prisma.DbNull) that no caller takes and no test can reach — the same
	 * shape as a status value with no live writer, which is indistinguishable
	 * from one whose writer has regressed. The READ side still returns null,
	 * because a row that predates this column genuinely has SQL NULL in it.
	 */
	chatChannels?: PublishingChatChannel[];
	/**
	 * The advisory recommendation preferences (1C-1b, §7.1(a)).
	 *
	 * Same three-state contract as `chatChannels`, and for the same reason:
	 * omitted leaves the stored value alone, `[]` CLEARS it, a list replaces it.
	 * A form that only edits cadence must not wipe preferences it never showed,
	 * and "clear my themes" must not silently mean "change nothing".
	 *
	 * Not nullable, again like `chatChannels` — `[]` already means none.
	 */
	preferredThemes?: string[];
	preferredPostTypes?: PublishingTopicPostType[];
	/**
	 * Nullable, UNLIKE the two lists — this one follows `lookbackDays`. null is
	 * how the form clears it; `undefined` leaves it alone. The empty string is
	 * not a third state: the boundary maps a cleared textarea to null so that a
	 * cleared field and a never-set field produce the same fingerprint.
	 */
	strategicPriorities?: string | null;
}

export async function upsertPublishingSuiteSettings(
	input: UpsertPublishingSuiteSettingsInput,
) {
	const { projectId, clientOrganizationId, createdByUserId, ...rest } = input;

	return db.$transaction(async (tx) => {
		// Lock the parent Project so a concurrent transfer cannot land between
		// deriving the tenant tuple and writing it. Without this lock, a
		// transfer that commits between the read below and the upsert would
		// leave organizationId/userId stale by the time they are written, so
		// the settings row would be stamped with the PREVIOUS owner's tuple —
		// pointing at a tenant the project no longer belongs to. Holding
		// FOR UPDATE on the project row for the whole transaction makes the
		// transfer wait, so the tuple written below is always the one still
		// true at commit. No automated test stages a concurrent transfer
		// against this window — the concurrency test in this file's __tests__
		// counterpart exercises a different property (disjoint partial
		// updates) and passes with or without this lock. Do not remove this
		// lock on the strength of a green suite.
		const locked = await tx.$queryRaw<
			{ id: string; userId: string; organizationId: string | null }[]
		>`SELECT "id", "userId", "organizationId" FROM "project" WHERE "id" = ${projectId} FOR UPDATE`;
		const project = locked[0];
		if (!project) {
			throw new PublishingSettingsProjectNotFoundError(projectId);
		}

		const organizationId = project.organizationId ?? null;
		// XOR-normalize: org context => userId NULL; personal => userId = owner.
		// Explicit `!= null` (not truthiness) so this agrees with the line above
		// even for a hypothetical empty-string organizationId.
		const tenantUserId =
			project.organizationId != null ? null : project.userId;

		// Reject only a positively-wrong NON-NULL client org. A guest on a
		// personal-context page legitimately sends null/omitted.
		if (
			clientOrganizationId != null &&
			clientOrganizationId !== organizationId
		) {
			throw new PublishingSettingsTenantMismatchError(projectId);
		}

		return tx.publishingSuiteSettings.upsert({
			where: { projectId },
			create: {
				projectId,
				organizationId,
				userId: tenantUserId,
				createdByUserId,
				cadence: rest.cadence ?? DEFAULT_PUBLISHING_CADENCE,
				lookbackDays: rest.lookbackDays ?? null,
				notificationsEnabled: rest.notificationsEnabled ?? true,
				chatChannels: rest.chatChannels,
				preferredThemes: rest.preferredThemes ?? [],
				preferredPostTypes: rest.preferredPostTypes ?? [],
				strategicPriorities: rest.strategicPriorities ?? null,
			},
			update: {
				...(rest.cadence !== undefined && { cadence: rest.cadence }),
				...(rest.lookbackDays !== undefined && {
					lookbackDays: rest.lookbackDays,
				}),
				...(rest.notificationsEnabled !== undefined && {
					notificationsEnabled: rest.notificationsEnabled,
				}),
				// `[]` passes through untouched — it is the off switch and must not
				// be folded into "unchanged", which is what an `|| undefined` here
				// would silently do.
				...(rest.chatChannels !== undefined && {
					chatChannels: rest.chatChannels,
				}),
				// `!== undefined`, never truthiness. `[]` is the CLEAR and must
				// reach the column; a `|| undefined` here would fold it back into
				// "unchanged" and make the clear button silently do nothing.
				...(rest.preferredThemes !== undefined && {
					preferredThemes: rest.preferredThemes,
				}),
				...(rest.preferredPostTypes !== undefined && {
					preferredPostTypes: rest.preferredPostTypes,
				}),
				// Same test for the same reason, except the value that must survive
				// it is null rather than `[]`.
				...(rest.strategicPriorities !== undefined && {
					strategicPriorities: rest.strategicPriorities,
				}),
				// Re-home the tenant tuple too: a transferred project's settings
				// row must follow it rather than keep the old owner's columns.
				organizationId,
				userId: tenantUserId,
				createdByUserId,
			},
			select: PUBLISHING_SUITE_SETTINGS_PUBLIC_SELECT,
		});
	});
}
