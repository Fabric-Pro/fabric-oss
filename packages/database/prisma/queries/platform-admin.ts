import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";

export function includesAdminRole(role: unknown): boolean {
	return (Array.isArray(role) ? role : [role]).some(
		(value) =>
			typeof value === "string" && value.split(",").includes("admin"),
	);
}

export function getOperatorOrganizationId(): string | undefined {
	return process.env.OPERATOR_ORGANIZATION_ID || undefined;
}

export async function hasOperatorMembership(userId?: string): Promise<boolean> {
	const organizationId = getOperatorOrganizationId();
	if (!organizationId) {
		return true;
	}
	if (!userId) {
		return false;
	}
	return Boolean(
		await db.member.findUnique({
			where: { organizationId_userId: { organizationId, userId } },
			select: { id: true },
		}),
	);
}

export async function isPlatformAdmin(
	user: { id: string; role?: string | null } | null | undefined,
): Promise<boolean> {
	return Boolean(
		user && user.role === "admin" && (await hasOperatorMembership(user.id)),
	);
}

export async function addOperatorMembershipForAdmin(
	tx: Prisma.TransactionClient,
	user: { id: string; role?: string | null },
): Promise<void> {
	const organizationId = getOperatorOrganizationId();
	if (!organizationId || !includesAdminRole(user.role)) {
		return;
	}
	await tx.member.upsert({
		where: { organizationId_userId: { organizationId, userId: user.id } },
		create: {
			organizationId,
			userId: user.id,
			role: "member",
			createdAt: new Date(),
		},
		update: {},
	});
}

export async function demoteDepartingOperator(
	organizationId: string,
	userId: string,
	transaction?: Prisma.TransactionClient,
): Promise<void> {
	if (organizationId !== getOperatorOrganizationId()) {
		return;
	}
	const demote = async (tx: Prisma.TransactionClient) => {
		const user = await tx.user.findUnique({
			where: { id: userId },
			select: { role: true },
		});
		if (!includesAdminRole(user?.role)) {
			return;
		}
		const role =
			user?.role
				?.split(",")
				.filter((value) => value !== "admin")
				.join(",") || "user";
		await tx.user.update({ where: { id: userId }, data: { role } });
		await recordAuditTx(tx, {
			action: "account.role_changed",
			actor: { type: "system" },
			organizationId,
			resource: { type: "user", id: userId },
			metadata: {
				fromRole: user?.role,
				toRole: role,
				reason: "operator_membership_ended",
			},
		});
	};
	if (transaction) {
		await demote(transaction);
	} else {
		await db.$transaction(demote);
	}
}
