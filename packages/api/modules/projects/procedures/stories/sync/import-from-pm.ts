import { ORPCError } from "@orpc/client";
import {
	createStory,
	db,
	Prisma,
	resolvePMConfigForUser,
	type StoryKind,
	type StorySource,
	updateStory,
} from "@repo/database";
import {
	applyLabelStatusMapOnPull,
	readLabelStatusMap,
} from "@repo/integrations/pm";
import {
	buildAdoIngestOptions,
	buildFizzyIngestOptions,
	ingestPulledImages,
	resolveAdoPat,
	resolveFizzyApiKey,
} from "@repo/integrations/pm/pull-image-ingest";
import { createStoryMediaPullStore } from "@repo/integrations/pm/pull-image-store";
import { logger } from "@repo/logs";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import {
	COMMON_URL_FIELDS,
	normalizeUrl,
	parseWorkItemTypeMapping,
	resolveKindFromPmType,
} from "@repo/utils";
import { z } from "zod";
import { getOrganizationIdFromContext } from "../../../../../orpc/middleware/tenant-context-middleware";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { stripInternalStoryFields } from "../../../lib/strip-internal-story-fields";
import {
	getGitLabIssueForPM,
	getProjectPMServerKey,
	isGitLabOfficialKey,
	resolveGitLabPMSource,
} from "./gitlab-pm-adapter";

type ProjectForImport = {
	id: string;
	organizationId: string | null;
	projectManagementMcpServerId: string | null;
	projectManagementMcpConfigId: string | null;
	projectManagementContainerId: string | null;
	projectManagementAdditionalContext: Record<string, string> | null;
};

type UserMcpConfig = {
	id: string;
	enabled: boolean;
	baseUrl?: string | null;
	mcpServer?: { defaultUrl?: string | null } | null;
};

async function fetchPMItemData({
	project,
	userMcpConfig,
	externalId,
	userId,
	organizationId,
}: {
	project: ProjectForImport;
	userMcpConfig: UserMcpConfig;
	externalId: string;
	userId: string;
	organizationId: string | undefined;
}): Promise<{
	title: string;
	description: string | null;
	externalUrl: string | null;
	labels: string[];
	source: StorySource;
	workItemType: string | null;
	// Plumbed out so the caller can use the discovered comment capability to
	// post a back-link comment on the source PM ticket after import.
	capabilities: import("@repo/temporal").PMToolCapabilities;
}> {
	const {
		analyzePMToolCapabilities,
		executeMcpTool,
		parsePMItemFromGetOutput,
		simpleHtmlToMarkdown,
		stripAttachmentBlock,
	} = await import("@repo/temporal");

	const { client, serverUrl } = await getCachedMcpClientForConfig({
		configId: userMcpConfig.id,
		userId,
		organizationId,
	});

	const baseUrl =
		userMcpConfig.baseUrl ||
		userMcpConfig.mcpServer?.defaultUrl ||
		serverUrl ||
		null;

	const toolsRaw = await client.tools();
	const tools: Record<
		string,
		{
			name: string;
			description?: string;
			inputSchema?: {
				type?: string;
				properties?: Record<string, unknown>;
				required?: string[];
			};
		}
	> = {};
	for (const [name, tool] of Object.entries(toolsRaw)) {
		tools[name] = {
			name,
			description: tool.description,
			inputSchema: tool.inputSchema as {
				type?: string;
				properties?: Record<string, unknown>;
				required?: string[];
			},
		};
	}

	const capabilities = analyzePMToolCapabilities(tools);

	if (!capabilities.taskGet) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"PM tool does not support fetching individual cards/issues",
		});
	}

	const getArgs: Record<string, unknown> = {
		[capabilities.taskGet.idParam]: externalId,
	};

	const additionalContext =
		project.projectManagementAdditionalContext as Record<
			string,
			string
		> | null;

	for (const param of capabilities.taskGet.additionalRequiredParams) {
		if (additionalContext?.[param]) {
			getArgs[param] = additionalContext[param];
		} else if (
			(param === "board_id" || param === "project") &&
			project.projectManagementContainerId
		) {
			getArgs[param] = project.projectManagementContainerId;
		}
	}

	const getResult = await executeMcpTool({
		toolName: capabilities.taskGet.toolName,
		args: getArgs,
		userId,
		organizationId,
		mcpConfigId: userMcpConfig.id,
	});

	if (!getResult.success) {
		const errMsg =
			typeof getResult.output === "string"
				? getResult.output
				: (getResult.output as { message?: string })?.message;
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: errMsg || "Failed to fetch work item from PM tool",
		});
	}

	const result = getResult.output;

	let pmItem: {
		title?: string;
		name?: string;
		summary?: string;
		description?: string;
		description_html?: string;
		body?: string;
		content?: string;
		details?: string;
		url?: string;
		link?: string;
		webUrl?: string;
		web_url?: string;
		html_url?: string;
		fields?: Record<string, unknown>;
	} = {};

	let payload: Record<string, unknown> = {};
	if (result && typeof result === "object") {
		const obj = result as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textContent = (
				obj.content as Array<{ type: string; text?: string }>
			).find((c) => c.type === "text");
			if (textContent?.text) {
				try {
					payload = JSON.parse(textContent.text) as Record<
						string,
						unknown
					>;
				} catch {
					payload = { title: textContent.text };
				}
			}
		} else {
			payload = obj;
		}
	}

	if (payload.fields && typeof payload.fields === "object") {
		const fields = payload.fields as Record<string, unknown>;
		pmItem = {
			title:
				(fields["System.Title"] as string) ||
				(fields["System.Name"] as string),
			description:
				(fields["System.Description"] as string) ||
				(fields["System.History"] as string),
			url: (payload._links as { web?: { href?: string } })?.web
				?.href as string,
			...payload,
		};
	} else {
		pmItem = payload as typeof pmItem;
	}

	const title =
		pmItem.title ||
		pmItem.name ||
		pmItem.summary ||
		`Imported: ${externalId}`;
	const isFizzy = (capabilities.detectedType ?? "").toLowerCase() === "fizzy";
	// Fizzy returns BOTH `description` (Action Text plain_text — attachments
	// collapse to `[filename]` placeholders) and `description_html` (the real
	// <action-text-attachment>/<img> markup). Prefer the HTML and convert it to
	// Fabric's markdown so the pull-image ingester can re-host the media; other
	// tools have no `description_html`, so they fall through unchanged (#1471).
	let description =
		(isFizzy &&
		typeof pmItem.description_html === "string" &&
		pmItem.description_html
			? pmItem.description_html
			: undefined) ||
		pmItem.description ||
		pmItem.body ||
		pmItem.content ||
		pmItem.details ||
		null;
	if (isFizzy && description) {
		description = simpleHtmlToMarkdown(description);
	}

	let rawUrl: string | null = null;
	const pmItemRecord = pmItem as Record<string, unknown>;
	for (const field of COMMON_URL_FIELDS) {
		if (pmItemRecord[field]) {
			rawUrl = String(pmItemRecord[field]);
			break;
		}
	}
	const externalUrl = normalizeUrl(rawUrl, baseUrl) ?? null;

	const rawLabels =
		(pmItem as Record<string, unknown>).labels ??
		(pmItem as Record<string, unknown>).tags ??
		(pmItem as Record<string, unknown>).label_names;

	let labels: string[] = [];
	if (Array.isArray(rawLabels)) {
		labels = rawLabels
			.filter(
				(l): l is string | number =>
					typeof l === "string" || typeof l === "number",
			)
			.map((l) => String(l).trim())
			.filter((l) => l.length > 0);
	} else if (typeof rawLabels === "string" && rawLabels.length > 0) {
		labels = rawLabels
			.split(",")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}

	const source = pmDetectedTypeToStorySource(capabilities.detectedType);

	const workItemType =
		parsePMItemFromGetOutput(result, { baseUrl }).workItemType ?? null;

	// Strip the Fabric-owned GitLab attachment block (Fizzy #1745) before it
	// reaches Fabric's story/editor/FeatureVersion snapshot: this generic MCP
	// path is shared by every PM tool, and this is the same "self-hosted /
	// non-official GitLab MCP" fetch source that a fresh import or a re-pull
	// (Import/overwrite) can land in `description` here — see the
	// `stripAttachmentBlock` no-op-elsewhere rationale in `pm-state-poll.ts`.
	description = description ? stripAttachmentBlock(description) : description;

	return {
		title,
		description,
		externalUrl,
		labels,
		source,
		workItemType,
		capabilities,
	};
}

function pmDetectedTypeToStorySource(
	detectedType: string | undefined,
): StorySource {
	switch ((detectedType ?? "").toLowerCase()) {
		case "jira":
			return "JIRA";
		case "azure-devops":
			return "AZURE_DEVOPS";
		case "fizzy":
			return "FIZZY";
		case "gitlab":
			return "GITLAB";
		case "linear":
			return "LINEAR";
		case "github":
			return "GITHUB";
		default:
			return "MANUAL";
	}
}

/**
 * Fetch-and-store images embedded in a pulled Azure DevOps description so they
 * render in Fabric (the raw ADO attachment URLs require a PAT the browser can
 * never send — they'd otherwise show as broken icons). No-op for non-ADO
 * sources or when no PAT is resolvable. Never throws — on any failure the
 * original description is returned unchanged so the import still succeeds.
 */
/** Read a Fizzy `account_slug` out of a project's PM additional-context JSON. */
function readFizzyAccountSlug(additionalContext: unknown): string | null {
	if (!additionalContext || typeof additionalContext !== "object") {
		return null;
	}
	const slug = (additionalContext as Record<string, unknown>).account_slug;
	return typeof slug === "string" && slug.trim() ? slug.trim() : null;
}

async function ingestPmImagesForStory(args: {
	description: string | null | undefined;
	source: StorySource;
	encryptedApiKey: string | null | undefined;
	/** Fizzy only — the Rails account slug (from PM additional context). */
	accountSlug?: string | null;
	projectId: string;
	storyId: string;
}): Promise<string | null | undefined> {
	const {
		description,
		source,
		encryptedApiKey,
		accountSlug,
		projectId,
		storyId,
	} = args;
	if (!description) {
		return description;
	}

	let options:
		| ReturnType<typeof buildAdoIngestOptions>
		| ReturnType<typeof buildFizzyIngestOptions>
		| null = null;
	if (source === "AZURE_DEVOPS") {
		const pat = resolveAdoPat(encryptedApiKey);
		if (pat) {
			options = buildAdoIngestOptions(pat);
		}
	} else if (source === "FIZZY") {
		const apiKey = resolveFizzyApiKey(encryptedApiKey);
		const slug = (accountSlug ?? "").trim();
		if (apiKey && slug) {
			options = buildFizzyIngestOptions(apiKey, slug);
		}
	}
	if (!options) {
		return description;
	}

	try {
		const result = await ingestPulledImages({
			description,
			projectId,
			storyId,
			store: createStoryMediaPullStore(),
			...options,
		});
		if (result.ingested || result.reused || result.failed) {
			logger.info("[Import from PM] pull image ingest", {
				storyId,
				source,
				ingested: result.ingested,
				reused: result.reused,
				failed: result.failed,
				skipped: result.skipped,
			});
		}
		return result.description;
	} catch (err) {
		logger.warn("[Import from PM] pull image ingest failed", {
			storyId,
			source,
			error: err instanceof Error ? err.message : String(err),
		});
		return description;
	}
}

/**
 * Returns true only when `error` is a Prisma P2002 unique-constraint violation
 * whose target is the `(projectId, externalId)` index — the constraint the
 * atomic create relies on to reject concurrent-pull losers.
 *
 * Prisma reports the violated target in `error.meta.target`, but the shape is
 * driver-dependent: it may be the index name (`"user_story_projectId_externalId_key"`),
 * an array of column names (`["projectId", "externalId"]`), or an underscore-
 * joined column string (`"projectId_externalId"`). We match when the target
 * either equals the index name or references BOTH `projectId` and `externalId`.
 * Any other P2002 (e.g. a per-project `identifier` collision) returns false so
 * the caller rethrows instead of misrouting into externalId winner-recovery.
 */
const EXTERNAL_ID_INDEX_NAME = "user_story_projectId_externalId_key";

function isExternalIdUniqueViolation(error: unknown): boolean {
	const isP2002 =
		(error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002") ||
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "P2002");
	if (!isP2002) {
		return false;
	}

	const target = (error as { meta?: { target?: unknown } }).meta?.target;

	// Flatten the target into a list of string tokens regardless of whether it
	// arrives as a string or an array of column names.
	const tokens: string[] = Array.isArray(target)
		? target.filter((t): t is string => typeof t === "string")
		: typeof target === "string"
			? [target]
			: [];

	if (tokens.length === 0) {
		return false;
	}

	// Index-name form: a single token matching the named constraint.
	if (tokens.includes(EXTERNAL_ID_INDEX_NAME)) {
		return true;
	}

	// Column form: the target must reference BOTH columns. Handles both the
	// array shape (["projectId","externalId"]) and the joined-string shape
	// ("projectId_externalId") by checking substring membership per token.
	const haystack = tokens.join(" ");
	return haystack.includes("projectId") && haystack.includes("externalId");
}

/**
 * Import a single GitLab issue for projects whose PM tool is the official
 * GitLab MCP server. Routes through `resolveGitLabSource` so REST-only
 * accounts (Free tier / auto-flipped configs) work the same as Premium.
 *
 * Mirrors the success-shape of the generic path so the dialog renders the
 * same confirmation. The back-link push to the source ticket is skipped on
 * this path: the generic-path push requires PM-tool taskUpdate
 * capabilities, and an update_issue write-path for GitLab REST can be
 * layered in later if needed.
 */
async function handleGitLabImport(args: {
	projectId: string;
	gitlabProjectId: string;
	organizationId: string | null;
	userId: string;
	userName: string | null;
	externalId: string;
	overwrite: boolean;
	labelStatusMapSource: unknown;
}) {
	const {
		projectId,
		gitlabProjectId,
		organizationId,
		userId,
		userName,
		externalId,
		overwrite,
		labelStatusMapSource,
	} = args;

	const source = await resolveGitLabPMSource({
		userId,
		organizationId,
		projectId,
	});
	if (!source) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"GitLab not connected. Connect your GitLab account in Settings → Integrations.",
		});
	}

	const existingStory = await db.userStory.findFirst({
		where: { projectId, externalId },
	});

	if (existingStory && !overwrite) {
		throw new ORPCError("CONFLICT", {
			message: `Story with external ID "${externalId}" already exists: ${existingStory.identifier}`,
		});
	}

	let fetched: Awaited<ReturnType<typeof getGitLabIssueForPM>>;
	try {
		fetched = await getGitLabIssueForPM({
			source,
			gitlabProjectId,
			externalId,
			userId,
			organizationId,
		});
	} catch (error) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message:
				error instanceof Error
					? error.message
					: "Failed to fetch GitLab issue",
		});
	}

	const { title, externalUrl, labels } = fetched;

	// Strip the Fabric-owned attachment block (Fizzy #1745) before this
	// GitLab-sourced description reaches Fabric's story, its FeatureVersion
	// snapshot, or the AI-Update context: without this, an Import/re-pull of
	// an issue that has been pushed-to (and so carries the block) writes the
	// block into Fabric, and the next push appends a second copy on top of
	// it — the exact accumulation the block-strip design exists to prevent.
	const { stripAttachmentBlock } = await import("@repo/temporal");
	const description = fetched.description
		? stripAttachmentBlock(fetched.description)
		: fetched.description;

	// Resolve label→status mapping ONCE, up front, so BOTH the overwrite and
	// create paths apply it. Re-pulling after fixing GitLab labels must move
	// the Fabric status; the overwrite path previously skipped this.
	const projectStatuses = await db.projectStoryStatus.findMany({
		where: { projectId },
		select: { id: true },
	});
	const validStatusIds = new Set(projectStatuses.map((s) => s.id));

	const labelStatusMap = readLabelStatusMap(labelStatusMapSource);
	const pullResult = applyLabelStatusMapOnPull(
		labels,
		labelStatusMap,
		validStatusIds,
	);

	const derivedStatusId =
		pullResult.kind === "matched" ? pullResult.statusId : null;
	const remainingLabels = pullResult.remainingLabels;
	const conflictingLabels =
		pullResult.kind === "conflict"
			? pullResult.conflictingLabels
			: undefined;

	// Shared overwrite/update routine — used both for an explicit overwrite of
	// a pre-existing story and to reconcile with the row that won a create race.
	const updateExisting = (id: string) =>
		updateStory(
			id,
			projectId,
			{
				title,
				description: description ?? undefined,
				externalUrl,
				labels: remainingLabels,
				...(derivedStatusId ? { statusId: derivedStatusId } : {}),
			},
			{
				lastEditedByName: userName,
				lastEditedSource: "PM_PULL",
			},
		);

	if (existingStory) {
		const updatedStory = await updateExisting(existingStory.id);

		return {
			success: true,
			story: stripInternalStoryFields(updatedStory),
			imported: { title, externalId, externalUrl },
			conflictingLabels,
		};
	}

	try {
		// Stamp `externalId` atomically in the INSERT so concurrent pulls can't
		// both pass the dedup check and create duplicate stories — the partial
		// unique index (projectId, externalId) now rejects the loser with P2002.
		const story = await createStory({
			projectId,
			title,
			description: description ?? undefined,
			createdById: userId,
			source: "GITLAB",
			externalId,
			externalUrl: externalUrl ?? undefined,
			labels: remainingLabels,
			pmAutoSyncEnabled: true,
			...(derivedStatusId ? { statusId: derivedStatusId } : {}),
		});

		const createdStory = await db.userStory.findUnique({
			where: { id: story.id },
			include: { status: true, tasks: true },
		});

		if (!createdStory) {
			// Should be impossible: we just created this row in the same
			// request. Surface a clear error rather than returning a null story.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Imported story could not be read back after creation",
			});
		}

		return {
			success: true,
			story: stripInternalStoryFields(createdStory),
			imported: { title, externalId, externalUrl },
			conflictingLabels,
		};
	} catch (error) {
		// Only recover when the P2002 is on the (projectId, externalId) unique
		// index. `createStory` also writes a per-project `identifier` (and other
		// fields) with their own unique constraints; a P2002 on a DIFFERENT
		// target must NOT be misrouted into the externalId winner-recovery (that
		// would silently overwrite the wrong story). Rethrow anything else.
		if (!isExternalIdUniqueViolation(error)) {
			throw error;
		}

		// A concurrent pull of the same issue won the create race. Reconcile
		// with the winner instead of erroring out.
		const winner = await db.userStory.findFirst({
			where: { projectId, externalId },
		});
		if (!winner) {
			throw error;
		}

		const updatedStory = await updateExisting(winner.id);

		return {
			success: true,
			story: stripInternalStoryFields(updatedStory),
			imported: { title, externalId, externalUrl },
			conflictingLabels,
		};
	}
}

/**
 * Record an inbound import as a "pull" `PmSyncLog` row so it shows in the Sync
 * History tab — the import paths here write the story directly (no
 * `syncStoryToPM`), so without this they log nothing. Reuses the Temporal
 * `recordPmSyncLog` (the same dynamic `@repo/temporal` import the back-link
 * push uses); it is non-fatal and falls back to a null correlationId outside
 * an activity context. Best-effort: a log-write must never fail the import.
 */
async function logImportPull(args: {
	storyId: string;
	storyTitle: string;
	pmTool: string;
	externalId: string;
	externalUrl: string | null;
	projectId: string;
	userId: string;
	organizationId: string | null;
}): Promise<void> {
	try {
		const { recordPmSyncLog } = await import("@repo/temporal");
		await recordPmSyncLog({
			direction: "pull",
			entityType: "STORY",
			entityId: args.storyId,
			title: args.storyTitle,
			pmTool: args.pmTool,
			status: "SUCCESS",
			actorUserId: args.userId,
			externalId: args.externalId,
			externalUrl: args.externalUrl,
			...(args.organizationId
				? { organizationId: args.organizationId, userId: null }
				: { organizationId: null, userId: args.userId }),
			projectId: args.projectId,
		});
	} catch (logError) {
		console.warn("[Import-from-PM] sync-log write failed", logError);
	}
}

export const importFromPMProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/import-from-pm",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Import story from PM tool",
		description:
			"Import a specific card/issue from PM tool by its external ID",
	})
	.input(
		z.object({
			projectId: z.string(),
			externalId: z.string().min(1, "External ID is required"),
			overwrite: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = getOrganizationIdFromContext(
			context.tenantContext,
		);

		// Defense-in-depth XOR tenant filter so a cross-tenant projectId
		// returns NOT_FOUND from the lookup itself, independent of upstream
		// permission middleware. The org branch scopes to the ORGANIZATION
		// only: org projects carry their creator's userId, so also filtering
		// by the caller's id would hide every teammate's project behind a
		// NOT_FOUND even though `requireProjectPermission(STORY_UPDATE)`
		// already authorized the caller (sibling procedures such as
		// list-pm-tickets.ts scope the same way). The personal branch keeps
		// `userId` — it is the only owner signal a personal project has.
		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// GitLab official routes through resolveGitLabSource so REST-only
		// users (Free tier or auto-flipped configs) can still import.
		const pmServerKey = await getProjectPMServerKey(
			project.projectManagementMcpServerId,
		);
		if (isGitLabOfficialKey(pmServerKey)) {
			if (!project.projectManagementContainerId) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Select a GitLab project in Project Settings before importing.",
				});
			}
			const gitlabResult = await handleGitLabImport({
				projectId: input.projectId,
				gitlabProjectId: project.projectManagementContainerId,
				organizationId: project.organizationId,
				userId: user.id,
				userName: user.name ?? null,
				externalId: input.externalId,
				overwrite: input.overwrite,
				labelStatusMapSource:
					project.projectManagementAdditionalContext,
			});
			if (gitlabResult.success && gitlabResult.story) {
				await logImportPull({
					storyId: gitlabResult.story.id,
					storyTitle: gitlabResult.story.title,
					pmTool: "gitlab",
					externalId: gitlabResult.imported.externalId,
					externalUrl: gitlabResult.imported.externalUrl ?? null,
					projectId: input.projectId,
					userId: user.id,
					organizationId: project.organizationId,
				});
			}
			return gitlabResult;
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"You have not connected your account to the project management tool. Please configure your MCP connection in Settings.",
			});
		}

		if (!userMcpConfig.enabled) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Your project management connection is disabled. Please enable it in Settings.",
			});
		}

		const existingStory = await db.userStory.findFirst({
			where: {
				projectId: input.projectId,
				externalId: input.externalId,
			},
		});

		if (existingStory && !input.overwrite) {
			throw new ORPCError("CONFLICT", {
				message: `Story with external ID "${input.externalId}" already exists: ${existingStory.identifier}`,
			});
		}

		const projectOrgIdForPM = project.organizationId || undefined;

		try {
			const {
				title,
				description,
				externalUrl,
				labels,
				source,
				workItemType: pmWorkItemType,
				capabilities,
			} = await fetchPMItemData({
				project: project as ProjectForImport,
				userMcpConfig,
				externalId: input.externalId,
				userId: user.id,
				organizationId: projectOrgIdForPM,
			});

			if (existingStory) {
				if (
					process.env.FEATURE_PM_TYPE_MAPPING === "true" &&
					pmWorkItemType
				) {
					const resolvedKind = resolveKindFromPmType(
						pmWorkItemType,
						parseWorkItemTypeMapping(
							project.projectManagementAdditionalContext as Record<
								string,
								unknown
							> | null,
						),
					);
					const existingKind = existingStory.kind;
					if (resolvedKind !== existingKind) {
						logger.warn(
							"[Import-from-PM] kind drift on overwrite",
							{
								storyId: existingStory.id,
								existingKind,
								resolvedKind,
								pmWorkItemType,
							},
						);
					}
				}

				const ingestedDescription = await ingestPmImagesForStory({
					description,
					source,
					encryptedApiKey: (
						userMcpConfig as { encryptedApiKey?: string | null }
					).encryptedApiKey,
					projectId: input.projectId,
					accountSlug: readFizzyAccountSlug(
						project.projectManagementAdditionalContext,
					),
					storyId: existingStory.id,
				});

				const updatedStory = await updateStory(
					existingStory.id,
					input.projectId,
					{
						title,
						description: ingestedDescription ?? undefined,
						externalUrl,
					},
					{
						lastEditedByName: user.name ?? null,
						lastEditedSource: "PM_PULL",
					},
				);

				await logImportPull({
					storyId: updatedStory.id,
					storyTitle: updatedStory.title,
					pmTool: capabilities.detectedType ?? "unknown",
					externalId: input.externalId,
					externalUrl: externalUrl ?? null,
					projectId: input.projectId,
					userId: user.id,
					organizationId: project.organizationId,
				});

				return {
					success: true,
					story: stripInternalStoryFields(updatedStory),
					imported: {
						title,
						externalId: input.externalId,
						externalUrl,
					},
				};
			}

			// Look up the project's current statuses to reject stale mappings.
			const projectStatuses = await db.projectStoryStatus.findMany({
				where: { projectId: input.projectId },
				select: { id: true },
			});
			const validStatusIds = new Set(projectStatuses.map((s) => s.id));

			const labelStatusMap = readLabelStatusMap(
				project.projectManagementAdditionalContext,
			);
			const pullResult = applyLabelStatusMapOnPull(
				labels,
				labelStatusMap,
				validStatusIds,
			);

			// Conflict path: multiple labels mapped to different statuses.
			// Don't pick a winner — surface the conflict so the user can
			// disambiguate. Stash all labels (including the conflicting
			// status labels) so they're preserved on the next push.
			const derivedStatusId =
				pullResult.kind === "matched" ? pullResult.statusId : null;
			const remainingLabels = pullResult.remainingLabels;
			const conflictingLabels =
				pullResult.kind === "conflict"
					? pullResult.conflictingLabels
					: undefined;

			const importedKind =
				process.env.FEATURE_PM_TYPE_MAPPING === "true" && pmWorkItemType
					? resolveKindFromPmType(
							pmWorkItemType,
							parseWorkItemTypeMapping(
								project.projectManagementAdditionalContext as Record<
									string,
									unknown
								> | null,
							),
						)
					: undefined;

			// Create the story
			const story = await createStory({
				projectId: input.projectId,
				title,
				description: description ?? undefined,
				createdById: user.id,
				source,
				...(importedKind ? { kind: importedKind as StoryKind } : {}),
			});

			// Pull-and-store any ADO images now that we have the story id (the
			// keyspace is story-scoped). Re-write the description to Fabric-
			// hosted refs so images render instead of showing broken icons.
			const ingestedDescription = await ingestPmImagesForStory({
				description,
				source,
				encryptedApiKey: (
					userMcpConfig as { encryptedApiKey?: string | null }
				).encryptedApiKey,
				projectId: input.projectId,
				accountSlug: readFizzyAccountSlug(
					project.projectManagementAdditionalContext,
				),
				storyId: story.id,
			});
			const descriptionChanged =
				(ingestedDescription ?? null) !== (description ?? null);

			// Update with external references, derived status, and preserved labels.
			// Stories imported from a PM tool opt into auto-sync at create time
			// so observable behavior matches the pre-toggle world (the feature
			// is already PM-linked; subsequent saves push by default). Fabric-
			// only create paths leave the column at its `false` default.
			const updatedStory = await db.userStory.update({
				where: { id: story.id },
				data: {
					externalId: input.externalId,
					externalUrl,
					labels: remainingLabels,
					pmAutoSyncEnabled: true,
					...(derivedStatusId ? { statusId: derivedStatusId } : {}),
					...(descriptionChanged
						? { description: ingestedDescription ?? undefined }
						: {}),
				},
				include: {
					status: true,
					tasks: true,
				},
			});

			// Record the inbound creation as a "pull". The back-link push
			// below logs a separate "push" row, so a fresh import shows a
			// pull then push pair (intended; the push is the back-link).
			await logImportPull({
				storyId: updatedStory.id,
				storyTitle: updatedStory.title,
				pmTool: capabilities.detectedType ?? "unknown",
				externalId: input.externalId,
				externalUrl: externalUrl ?? null,
				projectId: input.projectId,
				userId: user.id,
				organizationId: project.organizationId,
			});

			// Push the freshly-created Fabric story back to the PM tool so
			// the source PM ticket's description picks up the
			// "View in Fabric" link that createStory persisted on the
			// Fabric side. Best-effort — if this fails the import still
			// succeeded.
			if (
				capabilities.taskUpdate &&
				project.projectManagementContainerId
			) {
				try {
					const { syncStoryToPM } = await import("@repo/temporal");
					await syncStoryToPM({
						storyId: updatedStory.id,
						projectId: input.projectId,
						mcpConfigId: userMcpConfig.id,
						containerId: project.projectManagementContainerId,
						additionalContext:
							(project.projectManagementAdditionalContext as
								| Record<string, string>
								| null
								| undefined) ?? undefined,
						direction: "push",
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						capabilities,
					});
				} catch (pushBackError) {
					// Non-fatal — the import succeeded even if the
					// back-link could not be propagated to the PM ticket.
					console.warn(
						"[Import-from-PM] Back-link push-back failed",
						pushBackError,
					);
				}
			}

			return {
				success: true,
				story: stripInternalStoryFields(updatedStory),
				imported: {
					title,
					externalId: input.externalId,
					externalUrl,
				},
				conflictingLabels,
			};
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to import from PM tool",
			});
		}
		// Note: Do NOT close client - getCachedMcpClientForConfig manages cache
	});
