import {
	getOperatorOrganizationId,
	hasOperatorMembership,
	includesAdminRole,
	isPlatformAdmin,
} from "@repo/database";
import { APIError } from "better-auth/api";

export async function enforceOperatorAdminPolicy(
	ctx: { path?: string; body?: unknown },
	getCaller: () => Promise<
		{ id: string; role?: string | null } | null | undefined
	>,
): Promise<void> {
	// Without an operator organization, Better Auth's own admin checks decide,
	// exactly as before this policy existed.
	if (
		!getOperatorOrganizationId() ||
		!ctx.path?.startsWith("/admin/") ||
		ctx.path === "/admin/stop-impersonating"
	) {
		return;
	}
	if (!(await isPlatformAdmin(await getCaller()))) {
		throw new APIError("FORBIDDEN", {
			message:
				"Platform admin access requires operator organization membership",
		});
	}
	const body = ctx.body as
		| { userId?: string; role?: unknown; data?: { role?: unknown } }
		| undefined;
	const role =
		ctx.path === "/admin/update-user"
			? body?.data?.role
			: ctx.path === "/admin/create-user"
				? (body?.role ?? body?.data?.role)
				: ctx.path === "/admin/set-role"
					? body?.role
					: undefined;
	// A new account has no membership yet, even if data contains an existing id.
	if (
		includesAdminRole(role) &&
		!(await hasOperatorMembership(
			ctx.path === "/admin/create-user" ? undefined : body?.userId,
		))
	) {
		throw new APIError("FORBIDDEN", {
			message:
				"The admin role requires membership in the operator organization",
		});
	}
}
