import {
	db,
	isGitLabPersonalMcpServerKey,
	isPmServerIdKeySentinel,
	type PmSelectionSnapshot,
	readPmServerIdKeySentinel,
} from "@repo/database";
import {
	findUsableGitLabConnection,
	GITLAB_PM_ORIGIN_KEY,
	mcpRowOrigin,
	withGitLabPmOrigin,
} from "@repo/integrations/gitlab";

type PmSelection = PmSelectionSnapshot;

async function serverKeyOf(serverId: string): Promise<string | null> {
	if (isPmServerIdKeySentinel(serverId)) {
		return readPmServerIdKeySentinel(serverId);
	}
	const server = await db.mCPServer.findUnique({
		where: { id: serverId },
		select: { key: true },
	});
	return server?.key ?? null;
}

/**
 * The GitLab instance the actor is choosing a container on: the endpoint of
 * the selected GitLab MCP config when one is selected (it must be the
 * actor's own), otherwise the actor's GitLab connection. Null when neither
 * says — the selection then reads as gitlab.com, like a legacy one.
 */
async function actorGitLabOrigin(args: {
	actor: { userId: string; organizationId: string | null };
	configId: string | null;
}): Promise<string | null> {
	const { actor } = args;
	if (args.configId) {
		const tenantFilter = actor.organizationId
			? { organizationId: actor.organizationId, userId: actor.userId }
			: { organizationId: null, userId: actor.userId };
		const config = await db.mCPConfig.findFirst({
			where: { id: args.configId, ...tenantFilter },
			select: {
				baseUrl: true,
				mcpServer: { select: { key: true, defaultUrl: true } },
			},
		});
		if (config && isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
			return mcpRowOrigin(config);
		}
	}
	// The connection read can classify (write) a legacy connection row. A
	// person's GitLab connection lives in an organization (ADR-018), so with
	// none there is nothing to read — and nothing is written into a
	// no-organization tenant.
	if (!actor.organizationId) {
		return null;
	}
	const connection = await findUsableGitLabConnection({
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	return connection?.origin ?? null;
}

function recordedValue(additionalContext: unknown): string | null {
	if (
		additionalContext &&
		typeof additionalContext === "object" &&
		!Array.isArray(additionalContext)
	) {
		const value = (additionalContext as Record<string, unknown>)[
			GITLAB_PM_ORIGIN_KEY
		];
		return typeof value === "string" && value !== "" ? value : null;
	}
	return null;
}

/**
 * The `projectManagementAdditionalContext` to store for a save that may
 * change a project's PM selection, with the GitLab container's instance
 * (`recordedGitLabPmOrigin`) decided by the server:
 *
 *   - a `gitlabOrigin` sent by the client is never stored;
 *   - when the save selects a GitLab container — a new server, config or
 *     container, or a project that had none — the actor's GitLab instance is
 *     recorded (`actorGitLabOrigin`);
 *   - an unchanged GitLab selection keeps the stored instance (a legacy one
 *     stays unrecorded, i.e. gitlab.com), whoever saves;
 *   - a selection that is not a GitLab container records none.
 *
 * `next` fields left `undefined` were not sent and keep the stored value.
 * Returns `undefined` when nothing needs writing.
 */
export async function bindGitLabPmContainerOrigin(args: {
	actor: { userId: string; organizationId: string | null };
	stored: PmSelection | null;
	next: {
		serverId: string | null | undefined;
		configId: string | null | undefined;
		containerId: string | null | undefined;
		additionalContext: unknown;
	};
}): Promise<unknown> {
	const { stored, next } = args;
	const serverId =
		next.serverId !== undefined
			? next.serverId
			: (stored?.serverId ?? null);
	const configId =
		next.configId !== undefined
			? next.configId
			: (stored?.configId ?? null);
	const containerId =
		next.containerId !== undefined
			? next.containerId
			: (stored?.containerId ?? null);
	const selectionChanged =
		!stored ||
		serverId !== stored.serverId ||
		configId !== stored.configId ||
		containerId !== stored.containerId;

	const isGitLabContainer =
		serverId !== null &&
		containerId !== null &&
		isGitLabPersonalMcpServerKey(await serverKeyOf(serverId));

	const storedOrigin = recordedValue(stored?.additionalContext);
	const origin = !isGitLabContainer
		? null
		: selectionChanged
			? await actorGitLabOrigin({ actor: args.actor, configId })
			: storedOrigin;

	const sent = next.additionalContext !== undefined;
	if (!sent && origin === storedOrigin) {
		return undefined;
	}
	const base = sent ? next.additionalContext : stored?.additionalContext;
	if ((base === null || base === undefined) && origin === null) {
		return sent ? base : undefined;
	}
	return withGitLabPmOrigin(base, origin);
}

type PmSelectionInput = {
	serverId: string | null | undefined;
	configId: string | null | undefined;
	containerId: string | null | undefined;
	additionalContext: unknown;
};

/**
 * A guarded write found the PM selection changed since it was read: Prisma
 * `P2025` from `pmSelectionUnchangedWhere`, or `PmSelectionChangedError`
 * (which carries the same code) from a draft save.
 */
function isPmSelectionConflict(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2025"
	);
}

const PM_BINDING_ATTEMPTS = 3;

/**
 * Save a project's PM selection with the GitLab container's instance bound
 * from the row as it is when the write applies, not as an earlier read saw
 * it. `bindGitLabPmContainerOrigin` keeps the stored instance for an
 * unchanged selection; between that read and the write another save may
 * have changed the container (and recorded its own instance), and an
 * unconditional write would then pair this read's instance with that
 * container. So when the save writes any PM field, `write` receives the
 * selection the binding was derived from and must apply only while the row
 * still has it (`pmSelectionUnchangedWhere`); on a conflict the selection is
 * read again and bound again, up to three attempts, after which the conflict
 * is rethrown.
 */
export async function saveWithGitLabPmBinding<T>(args: {
	actor: { userId: string; organizationId: string | null };
	/** The selection as read before the save; null when there is no row yet. */
	stored: PmSelection | null;
	next: PmSelectionInput;
	/** Reads the row's current selection again after a conflict. */
	reread: () => Promise<PmSelection | null>;
	/**
	 * Performs the save with the context to store (`undefined`: leave the
	 * column alone). `expected` is `undefined` for an unconditional save
	 * (no PM field is written); otherwise the selection read (`null`: no
	 * row was read), which the write must require.
	 */
	write: (
		pmAdditionalContext: unknown,
		expected: PmSelection | null | undefined,
	) => Promise<T>;
}): Promise<T> {
	const writesPmFields =
		args.next.serverId !== undefined ||
		args.next.configId !== undefined ||
		args.next.containerId !== undefined ||
		args.next.additionalContext !== undefined;
	let stored = args.stored;
	for (let attempt = 1; ; attempt++) {
		const pmAdditionalContext = await bindGitLabPmContainerOrigin({
			actor: args.actor,
			stored,
			next: args.next,
		});
		// Binding may add the context even when the request sent none.
		const guarded = writesPmFields || pmAdditionalContext !== undefined;
		try {
			return await args.write(
				pmAdditionalContext,
				guarded ? stored : undefined,
			);
		} catch (error) {
			if (
				!guarded ||
				!isPmSelectionConflict(error) ||
				attempt >= PM_BINDING_ATTEMPTS
			) {
				throw error;
			}
			stored = await args.reread();
		}
	}
}

/** A project row's PM selection, for `saveWithGitLabPmBinding`. */
export function pmSelectionOf(row: {
	projectManagementMcpServerId: string | null;
	projectManagementMcpConfigId: string | null;
	projectManagementContainerId: string | null;
	projectManagementAdditionalContext: unknown;
}): PmSelection {
	return {
		serverId: row.projectManagementMcpServerId,
		configId: row.projectManagementMcpConfigId,
		containerId: row.projectManagementContainerId,
		additionalContext: row.projectManagementAdditionalContext,
	};
}

const PM_SELECTION_SELECT = {
	projectManagementMcpServerId: true,
	projectManagementMcpConfigId: true,
	projectManagementContainerId: true,
	projectManagementAdditionalContext: true,
} as const;

/** The project's current PM selection (no tenant filter: the write has one). */
export async function readProjectPmSelection(
	projectId: string,
): Promise<PmSelection | null> {
	const row = await db.project.findUnique({
		where: { id: projectId },
		select: PM_SELECTION_SELECT,
	});
	return row ? pmSelectionOf(row) : null;
}

/** The caller's wizard draft's current PM selection, if the draft exists. */
export async function readDraftPmSelection(args: {
	draftKey: string;
	actor: { userId: string; organizationId: string | null };
}): Promise<PmSelection | null> {
	const draft = await db.project.findFirst({
		where: {
			draftKey: args.draftKey,
			userId: args.actor.userId,
			organizationId: args.actor.organizationId,
			status: "DRAFT",
			deletedAt: null,
		},
		orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
		select: PM_SELECTION_SELECT,
	});
	return draft ? pmSelectionOf(draft) : null;
}
