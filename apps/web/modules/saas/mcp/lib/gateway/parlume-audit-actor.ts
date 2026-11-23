import type { AuditActor } from "@repo/database";
import { PARLUME_ACTOR_NAME } from "@repo/temporal/fabric-mcp-service-headers";
import type { GatewaySession } from "./types";

/**
 * Who an audit row a Parlume meeting turn causes names: Parlume, as an agent,
 * acting for the person who invited it. Undefined for any other call, which
 * keeps its own attribution.
 */
export function parlumeAuditActor(
	session: Pick<GatewaySession, "actingContext" | "userId">,
): AuditActor | undefined {
	return session.actingContext?.surface === "parlume"
		? {
				type: "agent",
				userId: session.userId,
				nameSnapshot: PARLUME_ACTOR_NAME,
			}
		: undefined;
}
