/**
 * The headers Fabric's own agent runtime (the Temporal worker) sends to the
 * Fabric MCP gateway to act for a user, and the reader the gateway parses them
 * with. Pure: no I/O and no `@repo/*` imports, so the web app can import it
 * through `@repo/temporal/fabric-mcp-service-headers` and both sides agree on
 * the names and on what a malformed value means.
 *
 * Two things prove a service call. The shared agent service secret proves the
 * caller is Fabric's runtime. The acting grant, minted by the web route that
 * accepted the person's chat turn, proves this turn acts for this user in this
 * organization; the worker carries it and cannot make one. The acting user and
 * organization say who it acts for, and the gateway re-checks membership on
 * every request, so naming a user here grants nothing the user does not hold.
 */

export const FABRIC_SERVICE_HEADERS = {
	token: "x-agent-service-token",
	actingGrant: "x-fabric-acting-grant",
	actingUser: "x-fabric-acting-user",
	actingOrganization: "x-fabric-acting-organization",
	project: "x-fabric-project",
	workspace: "x-fabric-workspace",
	surface: "x-fabric-surface",
	conversation: "x-fabric-conversation",
	sourceRunType: "x-fabric-source-run-type",
	sourceRunId: "x-fabric-source-run-id",
} as const;

const MAX_HEADER_VALUE_LENGTH = 200;
const MAX_GRANT_LENGTH = 2_000;
const HEADER_VALUE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const SURFACES = ["artifact", "workspace"] as const;
type ActingSurface = (typeof SURFACES)[number];

/** Where the acting user is when the agent calls a tool. Never widens access. */
interface FabricServiceActingContext {
	projectId?: string;
	workspaceId?: string;
	/** The kind of page the chat was opened from, when it is one a new page belongs on. */
	surface?: ActingSurface;
	conversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
}

/** Who a service call acts for, and where. */
export interface FabricServiceIdentity extends FabricServiceActingContext {
	userId: string;
	organizationId: string;
}

/** What the worker sends: the identity and the grant its web route minted. */
export interface FabricServiceActor extends FabricServiceIdentity {
	actingGrant: string;
}

/** What the gateway reads: the identity, and the grant if the call carried one. */
export interface FabricServiceRequestActor extends FabricServiceIdentity {
	actingGrant?: string;
}

function cleanValue(
	value: string | null | undefined,
	maxLength = MAX_HEADER_VALUE_LENGTH,
): string | undefined {
	if (!value) {
		return;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 &&
		trimmed.length <= maxLength &&
		HEADER_VALUE_PATTERN.test(trimmed)
		? trimmed
		: undefined;
}

/**
 * The request headers for one acting user. Optional context that does not look
 * like an identifier is left out rather than sent: a header is placement, and a
 * garbled one must not turn into a refusal of the whole call.
 */
export function buildFabricServiceHeaders(
	secret: string,
	actor: FabricServiceActor,
): Record<string, string> {
	const headers: Record<string, string> = {
		[FABRIC_SERVICE_HEADERS.token]: secret,
		[FABRIC_SERVICE_HEADERS.actingGrant]: actor.actingGrant,
		[FABRIC_SERVICE_HEADERS.actingUser]: actor.userId,
		[FABRIC_SERVICE_HEADERS.actingOrganization]: actor.organizationId,
	};
	const optional: Array<[string, string | undefined]> = [
		[FABRIC_SERVICE_HEADERS.project, actor.projectId],
		[FABRIC_SERVICE_HEADERS.workspace, actor.workspaceId],
		[FABRIC_SERVICE_HEADERS.surface, actor.surface],
		[FABRIC_SERVICE_HEADERS.conversation, actor.conversationId],
		[FABRIC_SERVICE_HEADERS.sourceRunType, actor.sourceRunType],
		[FABRIC_SERVICE_HEADERS.sourceRunId, actor.sourceRunId],
	];
	for (const [name, value] of optional) {
		const clean = cleanValue(value);
		if (clean) {
			headers[name] = clean;
		}
	}
	return headers;
}

/**
 * The actor a request names, or null when the user or the organization is
 * missing or malformed. Both are required: a service call with no one to act
 * for is refused, never defaulted. The grant is carried through unread; the
 * gateway verifies it.
 */
export function readFabricServiceActor(headers: {
	get(name: string): string | null;
}): FabricServiceRequestActor | null {
	const userId = cleanValue(headers.get(FABRIC_SERVICE_HEADERS.actingUser));
	const organizationId = cleanValue(
		headers.get(FABRIC_SERVICE_HEADERS.actingOrganization),
	);
	if (!userId || !organizationId) {
		return null;
	}
	return {
		userId,
		organizationId,
		actingGrant: cleanValue(
			headers.get(FABRIC_SERVICE_HEADERS.actingGrant),
			MAX_GRANT_LENGTH,
		),
		projectId: cleanValue(headers.get(FABRIC_SERVICE_HEADERS.project)),
		workspaceId: cleanValue(headers.get(FABRIC_SERVICE_HEADERS.workspace)),
		surface: SURFACES.find(
			(surface) =>
				surface ===
				cleanValue(headers.get(FABRIC_SERVICE_HEADERS.surface)),
		),
		conversationId: cleanValue(
			headers.get(FABRIC_SERVICE_HEADERS.conversation),
		),
		sourceRunType: cleanValue(
			headers.get(FABRIC_SERVICE_HEADERS.sourceRunType),
		),
		sourceRunId: cleanValue(
			headers.get(FABRIC_SERVICE_HEADERS.sourceRunId),
		),
	};
}

/**
 * When a grant stops being accepted, in unix seconds, read without verifying
 * it (the worker has no key; only the gateway can say a grant is good). Lets
 * the worker tell a person to send their message again instead of making a
 * call that is certain to be refused. Null for anything not shaped like one.
 */
export function readActingGrantExpiry(grant: string): number | null {
	const head = grant.split(".")[0];
	if (!head) {
		return null;
	}
	try {
		const body: unknown = JSON.parse(
			atob(head.replace(/-/g, "+").replace(/_/g, "/")),
		);
		const exp =
			typeof body === "object" && body !== null
				? (body as Record<string, unknown>).exp
				: undefined;
		return typeof exp === "number" ? exp : null;
	} catch {
		return null;
	}
}
