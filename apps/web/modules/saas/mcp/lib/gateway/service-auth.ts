/**
 * The service credential: Fabric's own agent runtime acting for a person.
 *
 * Three things have to hold, and each is checked here and nowhere else.
 *
 * 1. The shared agent service secret says the caller is Fabric's runtime. It
 *    says nothing about whom it acts for: the secret is shared by the worker,
 *    the agent containers and internal routes, and user and organization ids
 *    are not secret. A wrong secret is a plain 401 and never falls through to
 *    the cookie, so a browser that happens to send the header cannot borrow
 *    another identity.
 * 2. The acting grant says this turn acts for this user in this organization.
 *    The web route that accepted the person's chat turn minted it and the
 *    worker only carries it, so a leaked secret alone cannot be turned into
 *    "act as anyone". Missing, forged, expired or minted for someone else is a
 *    401 with the reason.
 * 3. Membership of the named organization is read on every request and the
 *    session is held to that one tenant, with `SERVICE_CREDENTIAL_SCOPES` and,
 *    only for a grant that names a project the person can open, the scopes of
 *    that grant within `SERVICE_GRANT_MAX_SCOPES`, on that project alone.
 *
 * Not admitted at a project's URL: the runtime reaches the organization-wide
 * gateway, and a project's URL is for a credential issued for that project.
 */

import {
	type ActingGrantFailure,
	checkActingGrant,
	isAgentServiceRequestAuthorized,
} from "@repo/api/lib/agent-service-auth";
import {
	db,
	isOrganizationMember,
	resolveOAuthProjectGrantTarget,
} from "@repo/database";
import {
	FABRIC_SERVICE_HEADERS,
	readFabricServiceActor,
} from "@repo/temporal/fabric-mcp-service-headers";
import { serviceSessionScopes } from "./tool-scope";
import type { GatewayActingContext } from "./types";

interface ServiceAuthResult {
	userId: string;
	organizationId: string;
	projectId: null;
	/**
	 * The one project the grant is limited to, or null for a chat grant. Not
	 * `projectId`: that is a connection made at a project's URL, which hides the
	 * organization-wide tools the runtime also holds.
	 */
	pinnedProjectId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
	credential: "service";
	scopes: string[];
	actingContext: GatewayActingContext;
}

export type ServiceAuthOutcome =
	| { status: "authenticated"; authResult: ServiceAuthResult }
	| { status: "unauthenticated" }
	| {
			status: "service_unauthorized";
			reason: `acting_grant_${ActingGrantFailure}`;
			message: string;
	  }
	| {
			status: "refused";
			reason:
				| "not_a_member"
				| "project_not_accessible"
				| "service_context_required";
			message: string;
	  };

const GRANT_REFUSALS: Record<ActingGrantFailure, string> = {
	missing: `A service call must carry the ${FABRIC_SERVICE_HEADERS.actingGrant} the chat turn was started with.`,
	invalid: "The acting grant is not valid.",
	expired:
		"The acting grant has expired. The person has to send their message again.",
	mismatch:
		"The acting grant was not issued for the user and organization this call names.",
};

function refusedNotAMember(organizationId: string): ServiceAuthOutcome {
	return {
		status: "refused",
		reason: "not_a_member",
		message: `Access denied: you are not a member of organization ${organizationId}`,
	};
}

export async function authenticateServiceRequest(
	request: { headers: Headers },
	binding: unknown,
): Promise<ServiceAuthOutcome> {
	if (
		!isAgentServiceRequestAuthorized(
			request.headers.get(FABRIC_SERVICE_HEADERS.token),
		)
	) {
		return { status: "unauthenticated" };
	}
	if (binding) {
		return {
			status: "refused",
			reason: "project_not_accessible",
			message: "Project not found or access denied",
		};
	}

	const actor = readFabricServiceActor(request.headers);
	if (!actor) {
		return {
			status: "refused",
			reason: "service_context_required",
			message: `A service call must name the user and organization it acts for on the ${FABRIC_SERVICE_HEADERS.actingUser} and ${FABRIC_SERVICE_HEADERS.actingOrganization} request headers.`,
		};
	}

	const grant = checkActingGrant(actor.actingGrant, actor);
	if (!grant.ok) {
		return {
			status: "service_unauthorized",
			reason: `acting_grant_${grant.reason}`,
			message: GRANT_REFUSALS[grant.reason],
		};
	}

	if (!(await isOrganizationMember(actor.userId, actor.organizationId))) {
		return refusedNotAMember(actor.organizationId);
	}
	// A grant that names a project is for that one project, and only if the
	// person it acts for can open it, in the organization it names.
	if (grant.projectId) {
		const target = await resolveOAuthProjectGrantTarget(
			actor.userId,
			grant.projectId,
		);
		if (!target || target.organizationId !== actor.organizationId) {
			return {
				status: "refused",
				reason: "project_not_accessible",
				message: "Project not found or access denied",
			};
		}
	}
	const user = await db.user.findUnique({
		where: { id: actor.userId },
		select: {
			name: true,
			email: true,
			role: true,
			banned: true,
			banExpires: true,
		},
	});
	if (!user) {
		return refusedNotAMember(actor.organizationId);
	}
	if (user.banned && (!user.banExpires || user.banExpires > new Date())) {
		return refusedNotAMember(actor.organizationId);
	}

	return {
		status: "authenticated",
		authResult: {
			userId: actor.userId,
			organizationId: actor.organizationId,
			projectId: null,
			userName: user.name || "Unknown",
			email: user.email,
			role: user.role === "admin" ? "admin" : "user",
			credential: "service",
			scopes: serviceSessionScopes(grant),
			pinnedProjectId: grant.projectId ?? null,
			actingContext: {
				projectId: actor.projectId,
				workspaceId: actor.workspaceId,
				surface: actor.surface,
				conversationId: actor.conversationId,
				sourceRunType: actor.sourceRunType,
				sourceRunId: actor.sourceRunId,
			},
		},
	};
}
