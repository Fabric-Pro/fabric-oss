import { ORPCError } from "@orpc/client";
import {
	type ApplyPmLinkStaleReason,
	applyPmLink,
	db,
	pmCreateClaimRecoverableAt,
	pmCreateClaimRecoveryCutoff,
} from "@repo/database";
import {
	extractCreatedWorkItemRefs,
	getTemporalClient,
	readCreatedTestCaseRefs,
} from "@repo/temporal";
import {
	discoverPMToolCapabilitiesResult,
	fetchPMItemsByIds,
} from "@repo/temporal/activities";
import {
	describePmSyncWorkflow,
	testCaseSyncWorkflowId,
} from "@repo/temporal/pm-sync-start";
import { pmRecoveryTooRecentMessage } from "./pm-recovery-messages";
import { type PMTarget, resolvePmTarget } from "./resolve-pm-target";

/**
 * "Link to existing item" for a story or a test case: the non-destructive
 * recovery from a PM create Fabric could not confirm or link. The user names
 * the PM item that create made; Fabric reads it through the project's
 * configured connection and links the row to it, clearing the create claim
 * the row held. Nothing is created, pushed or started: the next push updates
 * the linked item.
 *
 * Shared by `projects.stories.linkPmItem` and
 * `projects.testCases.sync.linkPmItem`. Not audited, like the other PM
 * recovery actions (retry, Unlink & re-create, dismiss).
 */

/** Typed refusal codes, carried as `data.errorCode` on the ORPCError. */
type LinkPmItemErrorCode =
	| "PM_LINK_ROW_NOT_FOUND"
	| "PM_LINK_ALREADY_LINKED"
	| "PM_LINK_SYNC_PENDING"
	| "PM_LINK_NO_PM_TOOL"
	| "PM_LINK_NO_BOARD"
	| "PM_LINK_INVALID_ID"
	| "PM_LINK_ITEM_NOT_FOUND"
	| "PM_LINK_PM_UNREACHABLE"
	| "PM_LINK_WRONG_PROJECT"
	| "PM_LINK_PROJECT_UNVERIFIED"
	| "PM_LINK_ID_UNREADABLE"
	| "PM_LINK_SYNC_UNVERIFIED"
	| "PM_LINK_ITEM_TAKEN"
	| "PM_RECOVERY_STALE"
	| "PM_RECOVERY_TOO_RECENT";

/**
 * Timeout for each step that talks to the PM tool: the capability discovery
 * (connect, OAuth preparation, tool list) and the verifying read. A hung PM
 * tool fails the request instead of holding it.
 */
const VERIFY_CALL_TIMEOUT_MS = 30_000;

/** The id form Azure DevOps and the GitLab REST create path store: a positive integer, no leading zeros. */
const NUMERIC_ID = /^[1-9]\d*$/;

/** The longest id Link stores for a tool whose ids are not plain numbers. */
const MAX_STORED_ID_LENGTH = 255;

/**
 * Whether `id` fits the form the tool's create path stores, checked on the
 * id Link is about to write: a positive integer for Azure DevOps and GitLab
 * (`numeric`); otherwise a non-empty string of at most
 * `MAX_STORED_ID_LENGTH` characters with no whitespace.
 */
function isStorableId(id: string, numeric: boolean): boolean {
	if (numeric) {
		return NUMERIC_ID.test(id);
	}
	return id.length > 0 && id.length <= MAX_STORED_ID_LENGTH && !/\s/.test(id);
}

type LinkPmItemRow = { storyId: string } | { testCaseId: string };

export interface LinkPmItemArgs {
	row: LinkPmItemRow;
	projectId: string;
	/** The PM item's id or key, as the user typed it (already trimmed). */
	externalId: string;
	userId: string;
	/**
	 * Called with the resolved PM target before the item is read; may throw
	 * to refuse (the test-case procedure's sync-capability gate).
	 */
	assertTargetSupported?: (
		target: PMTarget,
		organizationId: string | null,
	) => Promise<void>;
}

export interface LinkPmItemResult {
	linked: true;
	externalId: string;
	externalUrl: string | null;
}

function refuse(
	code: ConstructorParameters<typeof ORPCError>[0],
	errorCode: LinkPmItemErrorCode,
	message: string,
	extra: Record<string, unknown> = {},
): ORPCError<string, { errorCode: LinkPmItemErrorCode }> {
	return new ORPCError(code, { message, data: { errorCode, ...extra } });
}

/** The create claim read is held and too recent to clear. */
function claimTooRecent(recoverableAt: Date | null) {
	return refuse(
		"CONFLICT",
		"PM_RECOVERY_TOO_RECENT",
		pmRecoveryTooRecentMessage(recoverableAt),
		{ recoverableAt: recoverableAt?.toISOString() ?? null },
	);
}

const STALE_MESSAGES: Record<
	Exclude<ApplyPmLinkStaleReason, "claim-too-recent">,
	string
> = {
	missing:
		"This item was deleted after it was loaded, so Fabric did not link it.",
	linked: "This item was linked to a PM item after it was loaded, so Fabric did not link it again. Refresh to see its current link.",
	pending:
		"A sync of this item started after it was loaded, so Fabric did not link it. Wait for the sync to finish, refresh, and try again if it is still needed.",
	"claim-changed":
		"This item's pending create changed after it was loaded (another sync may be creating it right now), so Fabric did not link it. Refresh, check the PM tool, and try again if it is still needed.",
	changed:
		"This item changed after it was loaded, so Fabric did not link it. Refresh and try again.",
};

/** The row as read: its link, claim and attempt state. */
interface LinkRowState {
	identifier: string;
	externalId: string | null;
	pmCreateClaimId: string | null;
	pmCreateClaimedAt: Date | null;
	lastPmSyncStatus: string | null;
	lastPmSyncAttemptId: string | null;
}

async function readRow(
	row: LinkPmItemRow,
	projectId: string,
	organizationId: string | null,
): Promise<LinkRowState | null> {
	const select = {
		identifier: true,
		externalId: true,
		pmCreateClaimId: true,
		pmCreateClaimedAt: true,
		lastPmSyncStatus: true,
		lastPmSyncAttemptId: true,
	};
	// Scoped to the project the permission middleware authorized and to its
	// organization; a row in another project reads as missing.
	const scope = { projectId, project: { organizationId } };
	if ("testCaseId" in row) {
		return db.testCase.findFirst({
			where: { id: row.testCaseId, ...scope, deletedAt: null },
			select,
		});
	}
	return db.userStory.findFirst({
		where: { id: row.storyId, ...scope },
		select,
	});
}

function isAzureDevOps(capabilities: {
	detectedType?: string;
	availableTools?: string[];
}): boolean {
	return (
		capabilities.detectedType === "azure-devops" ||
		capabilities.detectedType === "ado" ||
		(capabilities.availableTools ?? []).some((name) => /^wit_/i.test(name))
	);
}

function describeError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.trim().slice(0, 200);
}

/**
 * Link the row to the named PM item, or throw an ORPCError whose
 * `data.errorCode` says why not. See the module comment.
 */
export async function linkPmItem(
	args: LinkPmItemArgs,
): Promise<LinkPmItemResult> {
	const { row, projectId, userId } = args;
	const isTestCase = "testCaseId" in row;
	const noun = isTestCase ? "test case" : "item";

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			organizationId: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			projectManagementAdditionalContext: true,
		},
	});
	if (!project) {
		throw refuse("NOT_FOUND", "PM_LINK_ROW_NOT_FOUND", "Project not found");
	}

	const current = await readRow(row, projectId, project.organizationId);
	if (!current) {
		throw refuse(
			"NOT_FOUND",
			"PM_LINK_ROW_NOT_FOUND",
			isTestCase ? "Test case not found" : "Item not found",
		);
	}
	if (current.externalId !== null) {
		throw refuse(
			"CONFLICT",
			"PM_LINK_ALREADY_LINKED",
			`This ${noun} is already linked to a PM item. Unlink it first to link it to another one.`,
		);
	}
	// Any PENDING row is refused, with or without an attempt id: a push may
	// be running on it. The write repeats this condition.
	if (current.lastPmSyncStatus === "PENDING") {
		throw refuse(
			"CONFLICT",
			"PM_LINK_SYNC_PENDING",
			`A sync of this ${noun} is in progress. Wait for it to finish, then try again if it is still needed.`,
		);
	}
	// A held create claim younger than the recovery bound: its push may
	// still be sending the create. Refused before the PM tool is read; the
	// write checks it again against the database clock.
	if (
		current.pmCreateClaimId !== null &&
		(current.pmCreateClaimedAt === null ||
			current.pmCreateClaimedAt > (await pmCreateClaimRecoveryCutoff(db)))
	) {
		throw claimTooRecent(
			pmCreateClaimRecoverableAt(current.pmCreateClaimedAt),
		);
	}

	const target = await resolvePmTarget({
		project: {
			projectManagementMcpServerId: project.projectManagementMcpServerId,
			projectManagementMcpConfigId: project.projectManagementMcpConfigId,
			projectManagementAdditionalContext:
				project.projectManagementAdditionalContext,
			organizationId: project.organizationId,
		},
		userId,
		organizationId: project.organizationId,
	});
	if (!target) {
		throw refuse(
			"BAD_REQUEST",
			"PM_LINK_NO_PM_TOOL",
			"No PM tool is configured for this project. Connect one in Integrations and select it in Project Settings → Project Management.",
		);
	}
	if (!project.projectManagementContainerId) {
		throw refuse(
			"BAD_REQUEST",
			"PM_LINK_NO_BOARD",
			"Select a board in Project Settings before linking a PM item.",
		);
	}
	await args.assertTargetSupported?.(target, project.organizationId);

	const organizationId = project.organizationId ?? undefined;

	// Which tool: Azure DevOps reads by numeric id under the project NAME and
	// is checked for the project below; GitLab REST issues are read inside
	// the configured GitLab project by construction. Discovery that fails
	// cannot tell Azure DevOps apart, so it refuses rather than skip the
	// project check.
	let ado = false;
	let idParamHint: string | undefined;
	let containerValue = project.projectManagementContainerId;
	if (target.kind === "mcp") {
		// Discovery is bounded: a hang in connect, OAuth preparation or the
		// tool list must not hold the request. A failure or timeout refuses.
		// `pmTarget` makes discovery refuse a personal GitLab config on another
		// instance than the container, as the sync paths do.
		let discovery: Awaited<
			ReturnType<typeof discoverPMToolCapabilitiesResult>
		>;
		try {
			discovery = await discoverPMToolCapabilitiesResult({
				mcpConfigId: target.mcpConfigId,
				userId,
				organizationId,
				pmTarget: {
					additionalContext:
						project.projectManagementAdditionalContext,
				},
				timeoutMs: VERIFY_CALL_TIMEOUT_MS,
			});
		} catch (error) {
			throw refuse(
				"SERVICE_UNAVAILABLE",
				"PM_LINK_PM_UNREACHABLE",
				`Couldn't reach the PM tool to check the item (${describeError(error)}). Try again in a moment.`,
			);
		}
		if (!discovery.ok) {
			throw refuse(
				"SERVICE_UNAVAILABLE",
				"PM_LINK_PM_UNREACHABLE",
				`Couldn't reach the PM tool to check the item (${describeError(discovery.error.message)}). Try again in a moment.`,
			);
		}
		const capabilities = discovery.capabilities;
		ado = isAzureDevOps(capabilities);
		// The story create reads the new item's id with the update tool's id
		// parameter as its first hint (`syncWorkItemToPM`).
		idParamHint = capabilities.taskUpdate?.idParam;
		if (ado) {
			containerValue =
				project.projectManagementContainerName ??
				project.projectManagementContainerId;
		}
	}

	// Azure DevOps and GitLab REST read an item by its plain number, which is
	// also the form their creates store; refuse any other spelling before the
	// read. (The id stored is derived from the fetched item below.)
	if (
		(ado || target.kind === "rest-gitlab") &&
		!NUMERIC_ID.test(args.externalId)
	) {
		throw refuse(
			"BAD_REQUEST",
			"PM_LINK_INVALID_ID",
			ado
				? "Enter the work item's ID number, for example 1234."
				: "Enter the issue's number, for example 42.",
		);
	}

	let fetched: Awaited<ReturnType<typeof fetchPMItemsByIds>>;
	try {
		fetched = await fetchPMItemsByIds({
			mcpConfigId: target.kind === "mcp" ? target.mcpConfigId : null,
			mcpServerId: project.projectManagementMcpServerId ?? undefined,
			containerId: containerValue,
			externalIds: [args.externalId],
			additionalContext:
				(project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null) ?? undefined,
			userId,
			organizationId,
			callTimeoutMs: VERIFY_CALL_TIMEOUT_MS,
		});
	} catch (error) {
		throw refuse(
			"SERVICE_UNAVAILABLE",
			"PM_LINK_PM_UNREACHABLE",
			`Couldn't reach the PM tool to check item "${args.externalId}" (${describeError(error)}). Try again in a moment.`,
		);
	}
	// A positive not-found only; every other failed or missing read is
	// "couldn't check", never "found".
	if (fetched.notFoundIds?.includes(args.externalId)) {
		throw refuse(
			"NOT_FOUND",
			"PM_LINK_ITEM_NOT_FOUND",
			`Item "${args.externalId}" was not found in the PM tool.`,
		);
	}
	const item = fetched.items.find((i) => i.id === args.externalId);
	if (!item || fetched.failedIds?.includes(args.externalId)) {
		const reason = fetched.failedIdErrors?.[args.externalId];
		throw refuse(
			"SERVICE_UNAVAILABLE",
			"PM_LINK_PM_UNREACHABLE",
			`Couldn't read item "${args.externalId}" from the PM tool${
				reason ? ` (${reason.trim().slice(0, 200)})` : ""
			}. Try again in a moment.`,
		);
	}

	// Azure DevOps reads a work item by its organization-wide id, so the item
	// must be shown to be in the project's Azure DevOps project, as the
	// ticket-id fast path checks (`getWorkItemsByIdsFromPM`'s `wrong_board`).
	// Unlike that path, an item whose project can't be read is refused, not
	// kept. Other MCP tools are not checked for the board or project the item
	// is in: their reads give no project field Fabric compares today. GitLab
	// REST reads only inside the configured GitLab project.
	if (ado) {
		const fields = (item.raw as { fields?: Record<string, unknown> })
			?.fields;
		const teamProject = fields?.["System.TeamProject"];
		const expected = project.projectManagementContainerName;
		if (
			!expected ||
			typeof teamProject !== "string" ||
			teamProject.length === 0
		) {
			throw refuse(
				"BAD_REQUEST",
				"PM_LINK_PROJECT_UNVERIFIED",
				`Fabric couldn't confirm that work item ${args.externalId} is in this project's Azure DevOps project, so it did not link it.`,
			);
		}
		if (teamProject !== expected) {
			throw refuse(
				"BAD_REQUEST",
				"PM_LINK_WRONG_PROJECT",
				`Work item ${args.externalId} is in the Azure DevOps project "${teamProject}", not "${expected}", so Fabric did not link it.`,
			);
		}
	}

	// The stamp the create path writes, so the next push's tool-mismatch
	// check (`detectExternalLinkMismatch`, which compares it with the active
	// server) treats the link as this tool's: a story's MCP push compares the
	// resolved config's server, its GitLab REST push the project's server; a
	// test case's create stamps the project's server on both paths.
	const externalMcpServerId =
		!isTestCase && target.kind === "mcp"
			? (target.mcpConfig.mcpServerId ?? null)
			: (project.projectManagementMcpServerId ?? null);
	const { externalId, externalUrl } = storedRefs({
		isTestCase,
		target,
		raw: item.raw,
		fetchedUrl: item.url ?? null,
		requestedId: args.externalId,
		idParamHint,
	});
	// The id about to be written must have the form the tool's create path
	// stores; anything else (no id, or one read from a malformed answer) is
	// refused rather than linked.
	if (
		!externalId ||
		!isStorableId(externalId, ado || target.kind === "rest-gitlab")
	) {
		throw refuse(
			"BAD_GATEWAY",
			"PM_LINK_ID_UNREADABLE",
			`Fabric read item "${args.externalId}" but could not read its ID from the PM tool's answer, so it did not link it.`,
		);
	}

	// Immediately before the write: a test case is refused while a push of
	// it runs under its one workflow id, as its Unlink & re-create is
	// (`retryTestCasePmSync`). A story has no such stable id to describe.
	// The write's WHERE is the guard for the rest.
	if ("testCaseId" in row) {
		await assertNoTestCaseSyncRunning(projectId, row.testCaseId);
	}
	const result = await applyPmLink({
		...row,
		projectId,
		expectedPmCreateClaimId: current.pmCreateClaimId,
		externalId,
		externalUrl,
		externalMcpServerId,
	});
	if (result.status === "taken") {
		const named =
			externalId === args.externalId
				? `"${externalId}"`
				: `"${args.externalId}" (stored as ${externalId})`;
		throw refuse(
			"CONFLICT",
			"PM_LINK_ITEM_TAKEN",
			result.otherIdentifier
				? `Item ${named} is already linked to ${result.otherIdentifier} in this project.`
				: `Item ${named} is already linked to another ${isTestCase ? "test case" : "item"} in this project.`,
		);
	}
	if (result.status === "stale" && result.reason === "claim-too-recent") {
		throw claimTooRecent(result.recoverableAt);
	}
	if (result.status === "stale") {
		throw refuse(
			"CONFLICT",
			"PM_RECOVERY_STALE",
			STALE_MESSAGES[result.reason],
		);
	}
	return { linked: true, externalId, externalUrl };
}

/**
 * Refuse while a push of the case is running under its single-case workflow
 * id (`testCaseSyncWorkflowId`), or when Temporal cannot say whether one is:
 * a running push may hold the case's create claim. A bulk test-case sync
 * runs under another id and is not seen here.
 */
async function assertNoTestCaseSyncRunning(
	projectId: string,
	testCaseId: string,
): Promise<void> {
	const unverified = () =>
		refuse(
			"SERVICE_UNAVAILABLE",
			"PM_LINK_SYNC_UNVERIFIED",
			"Fabric couldn't check whether a sync of this test case is running, so it did not link it. Try again in a moment.",
		);
	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await getTemporalClient();
	} catch {
		throw unverified();
	}
	const state = await describePmSyncWorkflow(
		client,
		testCaseSyncWorkflowId(projectId, testCaseId),
	);
	if (state === "running") {
		throw refuse(
			"CONFLICT",
			"PM_LINK_SYNC_PENDING",
			"A sync of this test case is in progress. Wait for it to finish, then try again if it is still needed.",
		);
	}
	if (state === "unknown") {
		throw unverified();
	}
}

/**
 * The id and URL the link stores: what the row type's create would have
 * stored for this item, read from the fetched item with the create's own
 * extraction, so two spellings of one item (a Jira key and its numeric id)
 * store one id and the project's unique index refuses the second link.
 *
 * - Story over MCP: `extractCreatedWorkItemRefs`, the single-item story
 *   create (`syncWorkItemToPM`, which retry and Unlink & re-create run),
 *   with the update tool's id parameter as the first hint.
 * - Test case over MCP: `readCreatedTestCaseRefs`, the test-case create
 *   (`createTestCaseInPmWithClaim`).
 * - GitLab REST (either): the issue number the read was keyed on
 *   (`getGitLabIssueForPM` reads by `issue_iid`, and the id was checked to
 *   be a plain number above). The REST read returns no id field to extract;
 *   the REST create stores the same plain iid.
 *
 * The URL is the fetched item's, else the one the create's extraction
 * reads. Empty values are `null`; an empty id is refused by the caller.
 */
function storedRefs(input: {
	isTestCase: boolean;
	target: PMTarget;
	raw: unknown;
	fetchedUrl: string | null;
	requestedId: string;
	idParamHint: string | undefined;
}): { externalId: string | null; externalUrl: string | null } {
	if (input.target.kind === "rest-gitlab") {
		return { externalId: input.requestedId, externalUrl: input.fetchedUrl };
	}
	const config = input.target.mcpConfig as {
		baseUrl?: string | null;
		mcpServer?: { defaultUrl?: string | null } | null;
	};
	const refs = input.isTestCase
		? readCreatedTestCaseRefs(input.raw)
		: extractCreatedWorkItemRefs(input.raw, {
				baseUrl: config.baseUrl || config.mcpServer?.defaultUrl || null,
				idParamHint: input.idParamHint,
			});
	const externalId = refs.externalId?.trim() || null;
	const externalUrl = input.fetchedUrl || refs.externalUrl || null;
	return { externalId, externalUrl };
}
