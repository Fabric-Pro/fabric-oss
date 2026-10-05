"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

/**
 * What the authorization in the page's address is bound to.
 *
 * An agent that was connected from a project asks for that project, and the
 * authorization endpoint does not carry the project in the query the page reads,
 * so the page asks the server for it by the two values it does carry: the client
 * and the PKCE challenge. The answer is the signed-in person's own view of it:
 *
 *   - `bound: false`: the agent asked for an organization, and the page behaves
 *     as it always did;
 *   - `bound: true` with a project: the agent asked for that project, and the
 *     page names it and its organization instead of asking for one;
 *   - `bound: true` with no project: the agent asked for a project this person
 *     cannot open, whether it is missing, deleted or not theirs.
 */
export function useAuthorizationBinding() {
	const searchParams = useSearchParams();
	const clientId = searchParams.get("client_id");
	const codeChallenge = searchParams.get("code_challenge");

	return useQuery({
		queryKey: ["oauth", "authorization-binding", clientId, codeChallenge],
		enabled: Boolean(clientId) && Boolean(codeChallenge),
		queryFn: () => {
			if (!clientId || !codeChallenge) {
				throw new Error("not an authorization request");
			}
			return orpcClient.users.oauthConnections.authorizationBinding({
				clientId,
				codeChallenge,
			});
		},
		retry: false,
	});
}
