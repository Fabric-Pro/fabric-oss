import { ORPCError } from "@orpc/client";
import {
	createManualPublishingTopic,
	Prisma,
	PublishingTopicProjectNotFoundError,
	PublishingTopicTenantMismatchError,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

export const createPublishingTopicProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics",
		tags: ["Projects", "Publishing Suite"],
		summary: "Create a manual topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(200),
			description: z.string().max(500).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_CREATE) gates
		// project access — only callers with create rights on this project reach
		// here.
		const user = context.user;

		// C-High (tenant TOCTOU): tenant resolution + insert MUST be atomic.
		// createManualPublishingTopic re-locks the Project row `FOR UPDATE`,
		// re-derives the XOR-normalized tenant tuple from the LOCKED row (never
		// from client input — P1/N1), performs the F2 client-org check against
		// that locked tuple, and inserts within the SAME transaction. A concurrent
		// org transfer cannot land between the tenant read and the insert. The
		// handler now only maps the helper's typed outcomes to ORPC error codes,
		// preserving the observable contract (NOT_FOUND / BAD_REQUEST / CONFLICT).
		try {
			const { topic } = await createManualPublishingTopic({
				projectId: input.projectId,
				clientOrganizationId: input.organizationId ?? null, // F2 guard only — never stamped
				createdById: user.id,
				title: input.title,
				description: input.description ?? null,
			});
			return { topic };
		} catch (error) {
			// Project vanished between authorization and the locked read.
			if (error instanceof PublishingTopicProjectNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Project not found",
				});
			}
			// F2: a positively-wrong non-null client org (checked race-free against
			// the locked tenant). null/omitted never reaches here — a guest on a
			// personal-context page passing `organizationId: null` succeeds.
			if (error instanceof PublishingTopicTenantMismatchError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "organizationId does not match the project",
				});
			}
			// M9: no exported `isUniqueViolation` helper exists (every repo copy
			// is module-local). Use the `Prisma` namespace re-exported by
			// @repo/database + the P2002 code, exactly as
			// packages/api/modules/projects/procedures/stories/tags.ts does.
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === "P2002"
			) {
				throw new ORPCError("CONFLICT", {
					message: "A topic on this subject already exists",
				});
			}
			throw error;
		}
	});
