import { ORPCError } from "@orpc/client";
import { db, getProjectAccessById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// Per-user Architecture Decision Log view preference. Permissive/optional on
// purpose — the web client owns the canonical shape and sanitizes on read, so
// new view options never need an API or database migration. Mirrors
// roadmap-view.ts.
const decisionsViewSchema = z
	.object({
		mode: z.enum(["list", "table"]).optional(),
	})
	.passthrough();
type DecisionsViewValue = z.infer<typeof decisionsViewSchema>;

// The `decisionsView` JSON column is added by migration
// 20260615000000_adl_pin_and_view_pref. The cast keeps the stored shape ours
// and degrades gracefully if a deploy runs before the Prisma client regenerates.
function getPreferenceDelegate() {
	return (
		db as typeof db & {
			projectUserPreference?: {
				findUnique: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					select: { decisionsView: true };
				}) => Promise<{ decisionsView: unknown } | null>;
				upsert: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					create: {
						projectId: string;
						userId: string;
						organizationId: string | null;
						decisionsView?: DecisionsViewValue;
					};
					update: {
						organizationId: string | null;
						decisionsView?: DecisionsViewValue;
					};
					select: { decisionsView: true };
				}) => Promise<{ decisionsView: unknown }>;
			};
		}
	).projectUserPreference;
}

const baseInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getDecisionsViewProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/decisions-view",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Get per-user Architecture Decision Log view preference",
	})
	.input(baseInput)
	.output(z.object({ decisionsView: decisionsViewSchema.nullable() }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getPreferenceDelegate();
		const pref = delegate
			? await delegate.findUnique({
					where: {
						projectId_userId: {
							projectId: input.projectId,
							userId: context.user.id,
						},
					},
					select: { decisionsView: true },
				})
			: null;
		const parsed = decisionsViewSchema.safeParse(pref?.decisionsView);
		return { decisionsView: parsed.success ? parsed.data : null };
	});

export const updateDecisionsViewProcedure = tenantProtectedProcedure
	// PROJECT_READ (not UPDATE): the row written is the caller's OWN per-user
	// view for a project they can already see.
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/decisions-view",
		tags: ["Projects", "Architecture Decisions"],
		summary: "Update per-user Architecture Decision Log view preference",
	})
	.input(baseInput.extend({ decisionsView: decisionsViewSchema }))
	.output(z.object({ decisionsView: decisionsViewSchema }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getPreferenceDelegate();
		if (!delegate) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Decisions view preference is unavailable until the Prisma client is regenerated.",
			});
		}
		const value = decisionsViewSchema.parse(input.decisionsView);
		const pref = await delegate.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: project.organizationId,
				decisionsView: value,
			},
			update: {
				organizationId: project.organizationId,
				decisionsView: value,
			},
			select: { decisionsView: true },
		});
		return { decisionsView: decisionsViewSchema.parse(pref.decisionsView) };
	});
