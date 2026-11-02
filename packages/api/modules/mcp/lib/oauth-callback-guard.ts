import { ORPCError } from "@orpc/server";
import { getOrganizationMembership } from "@repo/database";

const REFUSAL =
	"This connection cannot be completed. Start it again from your account.";

function refuse(): never {
	throw new ORPCError("FORBIDDEN", { message: REFUSAL });
}

/** Bind the callback to the account that started the flow. */
export async function assertMcpOAuthStateBoundToCaller(
	state: { userId: string } | null,
	caller: { id: string } | undefined,
): Promise<void> {
	if (!state?.userId || !caller?.id || state.userId !== caller.id) {
		refuse();
	}
}

/** Recheck the same config ownership or live organization role as start. */
export async function assertMcpOAuthConfigAccess(
	config: { userId: string | null; organizationId: string | null },
	caller: { id: string },
): Promise<void> {
	if (config.userId) {
		if (config.userId !== caller.id) {
			refuse();
		}
		return;
	}
	if (config.organizationId) {
		let role: string | undefined;
		try {
			role = (
				await getOrganizationMembership(
					config.organizationId,
					caller.id,
				)
			)?.role;
		} catch {
			refuse();
		}
		if (role !== "admin" && role !== "owner") {
			refuse();
		}
		return;
	}
	refuse();
}

/** A failed or raced conditional write has the same response as an unknown state. */
export function assertMcpOAuthStateConsumed(consumed: boolean): void {
	if (!consumed) {
		refuse();
	}
}
