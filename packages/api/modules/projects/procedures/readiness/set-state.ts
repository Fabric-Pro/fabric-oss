import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { gatherReadinessEvidence } from "../../lib/readiness/evidence";
import { READINESS_RULES_BY_KEY } from "../../lib/readiness/registry";

/**
 * The three manual readiness actions (Fizzy #2165).
 *
 * They differ in REACH, and that difference is the whole design:
 *
 *  - **Snooze** is personal. It quiets one person's reminder and must not
 *    silently change what teammates see, so the row carries
 *    `personalForUserId` and any project member may set one.
 *  - **Not applicable** speaks for the whole project — it asserts the item does
 *    not apply here, and it resolves every item that depends on it. That is a
 *    statement about the project rather than about the person making it, so it
 *    is gated on project-edit rights.
 *  - **Request help** is also project-wide, and additionally sets a flag that is
 *    never cleared, so the friction stays visible after the item resolves.
 *
 * Completion is not settable. It is derived on read and has no mutation here.
 */

const ITEM_KEY_UNKNOWN = "Unknown readiness item.";

async function assertEnabled(): Promise<void> {
	if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Project readiness is not enabled.",
		});
	}
}

function assertKnownItem(itemKey: string): void {
	if (!READINESS_RULES_BY_KEY.has(itemKey)) {
		throw new ORPCError("BAD_REQUEST", { message: ITEM_KEY_UNKNOWN });
	}
}

async function resolveTenant(projectId: string) {
	const gathered = await gatherReadinessEvidence(projectId);
	if (!gathered) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found." });
	}
	return gathered.tenant;
}

const StateOutput = z.object({ ok: z.literal(true) });

/**
 * Upsert the single project-wide row for an item.
 *
 * Not a Prisma `upsert`, because Prisma cannot target a compound unique whose
 * column is NULL — the same limitation that made the partial unique index
 * necessary in the first place. So this reads then writes.
 *
 * That leaves a narrow race: two concurrent requests can both miss the read and
 * both try to create. The partial unique index is what makes that safe — the
 * loser gets a constraint violation rather than a duplicate project-wide row.
 * The index is load-bearing here, not decorative.
 */
async function upsertProjectWideState(args: {
	projectId: string;
	itemKey: string;
	tenant: { userId: string | null; organizationId: string | null };
	create: {
		state: "NOT_APPLICABLE" | "HELP_REQUESTED";
		everHelpRequested?: boolean;
		helpRequestedAt?: Date;
	};
	update: {
		state: "NOT_APPLICABLE" | "HELP_REQUESTED";
		helpRequestedAt?: Date;
		snoozeUntil: null;
	};
}): Promise<void> {
	const { projectId, itemKey, tenant } = args;

	const existing = await db.projectReadinessItemState.findFirst({
		where: { projectId, itemKey, personalForUserId: null },
		select: { id: true },
	});

	if (existing) {
		await db.projectReadinessItemState.update({
			where: { id: existing.id },
			data: args.update,
		});
		return;
	}

	await db.projectReadinessItemState.create({
		data: {
			projectId,
			itemKey,
			personalForUserId: null,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
			...args.create,
		},
	});
}

/**
 * Snooze an item until a chosen date, or lift a snooze already in place.
 *
 * Personal to the caller: two people can hold different snoozes on the same
 * item, which is why the uniqueness key includes the user — and why lifting one
 * only ever touches the caller's own row.
 *
 * `until: null` means "not snoozed any more". FR22 listed Open Target, Snooze,
 * Mark Not Applicable and Request Help, and none of them undid a snooze, so
 * someone who mis-clicked had to wait out the expiry. Modelled as a nullable
 * date rather than a second procedure because there is one concept here — when
 * this item should come back — and null is simply "now".
 */
export const snoozeReadinessItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/{itemKey}/snooze",
		tags: ["Projects", "Readiness"],
		summary: "Snooze a readiness item",
		description:
			"Defers a readiness item for the calling user only, until the given date.",
	})
	.input(
		z.object({
			projectId: z.string(),
			itemKey: z.string(),
			/** When the item should come back. `null` lifts the snooze. */
			until: z.date().nullable(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(StateOutput)
	.handler(async ({ input, context }) => {
		await assertEnabled();
		assertKnownItem(input.itemKey);
		const tenant = await resolveTenant(input.projectId);

		if (input.until === null) {
			// Same shape as clearing Not Applicable: remove the row rather than
			// write a "cleared" state, so the item goes back to being judged on
			// its detection alone. Scoped to this caller's own row — lifting my
			// snooze must not lift yours.
			await db.projectReadinessItemState.deleteMany({
				where: {
					projectId: input.projectId,
					itemKey: input.itemKey,
					personalForUserId: context.user.id,
					state: "SNOOZED",
				},
			});
			return { ok: true as const };
		}

		await db.projectReadinessItemState.upsert({
			where: {
				projectId_itemKey_personalForUserId: {
					projectId: input.projectId,
					itemKey: input.itemKey,
					personalForUserId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				itemKey: input.itemKey,
				state: "SNOOZED",
				personalForUserId: context.user.id,
				snoozeUntil: input.until,
				userId: tenant.userId,
				organizationId: tenant.organizationId,
			},
			update: { state: "SNOOZED", snoozeUntil: input.until },
		});

		return { ok: true as const };
	});

/**
 * Mark an item not applicable for the whole project, or clear that mark.
 *
 * Gated on project-edit rights because it changes what every member sees and,
 * through the cascade, resolves the items that depend on it.
 */
export const setReadinessItemNotApplicableProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/{itemKey}/not-applicable",
		tags: ["Projects", "Readiness"],
		summary: "Mark a readiness item not applicable",
		description:
			"Marks a readiness item not applicable for the whole project, or clears the mark.",
	})
	.input(
		z.object({
			projectId: z.string(),
			itemKey: z.string(),
			notApplicable: z.boolean(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(StateOutput)
	.handler(async ({ input }) => {
		await assertEnabled();
		assertKnownItem(input.itemKey);
		const tenant = await resolveTenant(input.projectId);

		if (!input.notApplicable) {
			// Clearing removes the project-wide row entirely rather than writing
			// some "cleared" state — an item with no row is simply back to being
			// judged on its detection, which is the state we want to return to.
			await db.projectReadinessItemState.deleteMany({
				where: {
					projectId: input.projectId,
					itemKey: input.itemKey,
					personalForUserId: null,
					state: "NOT_APPLICABLE",
				},
			});
			return { ok: true as const };
		}

		await upsertProjectWideState({
			projectId: input.projectId,
			itemKey: input.itemKey,
			tenant,
			create: { state: "NOT_APPLICABLE" },
			update: { state: "NOT_APPLICABLE", snoozeUntil: null },
		});

		return { ok: true as const };
	});

/**
 * Ask for help on an item. Project-wide, and sets `everHelpRequested` which is
 * never cleared — the point of that flag is to survive the item resolving, so
 * repeated friction on one item stays visible afterwards.
 */
export const requestReadinessHelpProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/{itemKey}/request-help",
		tags: ["Projects", "Readiness"],
		summary: "Request help for a readiness item",
		description:
			"Flags a readiness item as needing help and records that it ever did.",
	})
	.input(
		z.object({
			projectId: z.string(),
			itemKey: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(StateOutput)
	.handler(async ({ input }) => {
		await assertEnabled();
		assertKnownItem(input.itemKey);
		const tenant = await resolveTenant(input.projectId);
		const now = new Date();

		await upsertProjectWideState({
			projectId: input.projectId,
			itemKey: input.itemKey,
			tenant,
			create: {
				state: "HELP_REQUESTED",
				everHelpRequested: true,
				helpRequestedAt: now,
			},
			// `everHelpRequested` is deliberately absent from the update: once true
			// it must stay true, and re-asserting it here would be the obvious
			// place for a later edit to accidentally set it false.
			update: {
				state: "HELP_REQUESTED",
				helpRequestedAt: now,
				snoozeUntil: null,
			},
		});

		await db.projectReadinessItemState.updateMany({
			where: {
				projectId: input.projectId,
				itemKey: input.itemKey,
				personalForUserId: null,
				everHelpRequested: false,
			},
			data: { everHelpRequested: true },
		});

		return { ok: true as const };
	});
