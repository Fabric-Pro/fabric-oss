import {
	getPublishingListPreference,
	setPublishingListPreference,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

const SortSchema = z.enum([
	"RECOMMENDED",
	"RECENTLY_UPDATED",
	"RECENTLY_CREATED",
]);
const ViewSchema = z.enum(["LIST", "TWO_COLUMN"]);

const PreferenceSchema = z.object({
	sort: SortSchema,
	view: ViewSchema,
});

/**
 * The caller's own Inbox preferences for a project.
 *
 * Gated on PUBLISHING_TOPIC_READ, not _UPDATE: choosing how YOUR list is sorted
 * is not editing anything, and requiring edit rights would leave a read-only
 * member permanently on a default they can see is wrong for them.
 *
 * A reader with no stored row gets the defaults rather than a 404 — absence and
 * "the defaults" are the same state, and nothing writes on read.
 */
export const getPublishingListPreferenceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-preferences",
		tags: ["Projects", "Publishing Suite"],
		summary: "Get the caller's Inbox sort and layout for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(PreferenceSchema)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		// AUTHORIZATION: always the AUTHENTICATED user. The input carries no
		// userId, so one caller can never read another's preference.
		return await getPublishingListPreference({
			userId: context.user.id,
			projectId: input.projectId,
		});
	});

/**
 * Store the caller's own Inbox preference.
 *
 * PARTIAL: both fields are optional and only what is sent is written, because
 * the two controls are independent and changing the sort must not silently
 * reset a layout somebody chose last week.
 *
 * `organizationId` stays a GUARD and never a scoping key — the stored row takes
 * its tenant from the PROJECT, inside the query, for the reason ADR-018 gives:
 * a tenant read from ambient caller input is a row RLS will place wrongly.
 */
export const setPublishingListPreferenceProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-preferences",
		tags: ["Projects", "Publishing Suite"],
		summary: "Set the caller's Inbox sort and layout for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sort: SortSchema.optional(),
			view: ViewSchema.optional(),
		}),
	)
	.output(PreferenceSchema)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		return await setPublishingListPreference({
			userId: context.user.id,
			projectId: input.projectId,
			sort: input.sort,
			view: input.view,
		});
	});
