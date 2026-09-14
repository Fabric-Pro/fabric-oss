/**
 * The oRPC-flavoured face of the agent endpoint guard.
 *
 * The rules, the `AGENT_DISCOVERY_ALLOWED_HOSTS` allowlist and the guarded
 * fetch all live in `@repo/utils/agent-endpoint`. They had to move there: the
 * same guard is needed by the Temporal activities that relay to a stored
 * `deploymentUrl` and by the web route that relays a caller-supplied one, and
 * neither package can import `@repo/api` — `@repo/api` depends on
 * `@repo/temporal`, so the arrow only goes one way.
 *
 * What stays here is the part that is specific to a procedure: turning a
 * refusal into an `ORPCError`. Every registry procedure imports these two
 * names and is unaffected by where the logic sits.
 */

import { ORPCError } from "@orpc/server";
import { agentEndpointRefusal } from "@repo/utils/agent-endpoint";

export { fetchAgentEndpoint } from "@repo/utils/agent-endpoint";

/**
 * Refuse a deployment URL the server must not be pointed at.
 *
 * Throws `BAD_REQUEST` rather than `FORBIDDEN`: the caller is allowed to
 * register agents, the address they supplied is the problem, and the message
 * names which address rule it broke so a self-hoster can see what to add to
 * `AGENT_DISCOVERY_ALLOWED_HOSTS`.
 */
export function assertAgentEndpointAllowed(urlString: string): void {
	const refusal = agentEndpointRefusal(urlString);
	if (refusal) {
		throw new ORPCError("BAD_REQUEST", { message: refusal });
	}
}
