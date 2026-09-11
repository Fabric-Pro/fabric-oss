/**
 * Gathers everything the readiness rules are allowed to read (Fizzy #2165).
 *
 * The rules never query. They receive this bundle and nothing else, which keeps
 * the cost of 27 rules at zero extra round trips and makes each rule testable
 * against a plain object rather than a database.
 *
 * Six aggregate reads, not twenty-six: roughly half the rules resolve from
 * columns already on the project row, and the rest are grouped counts.
 */

import { db, isFeatureEnabled, type ProjectStatus } from "@repo/database";
import type { ReadinessEvidence } from "./types";

/** Document statuses that mean the document is actually usable. */
const USABLE_DOCUMENT_STATUSES = ["COMPLETE", "REVIEW"] as const;

/**
 * Statuses a document passes through while a run is working on it. A row in one
 * of these still counts when it already holds content — see the document read
 * below for why.
 *
 * QUEUED belongs here for exactly the same reason GENERATING does: a re-run that
 * is waiting on the project's context-building work has not touched the existing
 * content yet, so dropping the row would resurface a long-satisfied checklist
 * item the moment someone hit Refresh — and a dependency wait can last an hour.
 */
const RERUNNING_DOCUMENT_STATUSES = ["QUEUED", "GENERATING", "FAILED"] as const;

/**
 * Context sources only count once extraction has finished successfully — a
 * source that failed to extract has given the project nothing.
 */
const INDEXED = "COMPLETED" as const;

/**
 * One credential that has reached this organization over MCP, as the reach
 * record carries it. `credentialId` is polymorphic across `user_api_key` and
 * `organization_api_key`, which is why the kind has to travel with it — see the
 * `OrganizationCliReach` model doc.
 */
interface CliReachRecord {
	credentialKind: "USER_API_KEY" | "ORGANIZATION_API_KEY";
	credentialId: string;
}

/**
 * How many reach records one connection check will look at (Fizzy #2457).
 *
 * The table only grows. Every distinct credential that ever reaches MCP leaves
 * a permanent row, nothing prunes them, and key creation carries no per-user or
 * per-organization cap — so a permitted member can mint a key, make one call,
 * abandon it and repeat, and each iteration would otherwise add a row that
 * every future readiness read for that organization has to materialise and feed
 * into the two `id: { in: [...] }` lookups. Readiness latency for EVERY project
 * in the organization would then scale with a list one member controls.
 *
 * So the read is bounded, and ordered `lastReachedAt` descending: the most
 * recently active credentials are overwhelmingly the ones most likely to still
 * be alive, which is the only question being asked of them.
 *
 * 100 rather than a tighter number for two reasons. It is far above any
 * plausible count of credentials a real team keeps in rotation — a person holds
 * a handful of personal keys and an organization key is shared — so no honest
 * organization is ever truncated; and it is small enough that both `IN (...)`
 * lists stay trivial for Postgres even in the worst case.
 *
 * **The honest cost.** An organization holding more than 100 dead-but-more-
 * recently-active credentials, plus one live credential older than all of them,
 * reads as disconnected. That is acceptable because this answer drives a NUDGE,
 * not an authorization decision: nothing is granted or refused by it. The worst
 * outcome is a checklist row that says "not connected" beside an offer to
 * create a key, on an organization that has been minting and abandoning keys by
 * the hundred — a state worth noticing on its own.
 *
 * Deliberately NOT solved here, and known follow-ups rather than oversights: a
 * job that prunes reach records whose key row is gone, a cap on key issuance,
 * and answering liveness in one query instead of two. Each is its own change.
 */
const CLI_REACH_READ_LIMIT = 100;

/**
 * Does this organization have a CLI reaching Fabric right now (Fizzy #2457, R2)?
 *
 * Anchored on the reach records, never on the key tables. Nothing here
 * re-derives which organization a credential reaches, whether its owner was a
 * member at the time, or whether the caller was a CLI at all: the MCP runtime
 * decided all three inside the request, and every attempt to reproduce them
 * afterwards reproduced them wrongly — scopes are enforced per tool call, usage
 * counters are stamped before the membership check, and a personal key's
 * organization is only *defaulted* from its holder's memberships. What is read
 * here is the credential's continued LIFE, which is a fact about now that no
 * historical record can carry.
 *
 * Alive means all four of: the key row still exists, it is active, it is
 * unexpired, and its owner still holds membership of this organization. Those
 * are exactly the conditions the MCP hosts re-check on every request, so an
 * organization reads connected precisely while one of its credentials would
 * still be let in.
 *
 * **A missing key row means dead.** Organization keys are hard-deleted by the
 * revoke path and `credentialId` carries no foreign key, so a record can outlive
 * its key. The absent row IS the revocation, and an id-list lookup reports it as
 * such by simply not matching. Nothing cleans the orphaned record up on the
 * write path; it is harmless and self-describing.
 *
 * Three queries: the reach records, then one lookup per key kind, each carrying
 * an id list bounded by {@link CLI_REACH_READ_LIMIT}. An empty list is not asked
 * at all, and a kind no record points at is not asked at all.
 *
 * Only ever called with the rollout gate ON, and the only place READINESS
 * touches `organization_cli_reach` at all — so a gated-off organization's
 * readiness never depends on the table existing. See the gather below.
 *
 * That is a claim about this surface, not about the deployment. The MCP
 * runtime writes reach records on every authenticated request WITHOUT
 * consulting the gate (`recordCliReach` in `@saas/mcp/lib/record-cli-reach`),
 * deliberately: the fact has to accumulate before an organization is switched
 * on, or the first thing the gate reveals is an empty answer for a team that
 * has been connected all along. So the branch as a whole still requires
 * migration-before-code. What the isolation here buys is that a schema lag
 * costs swallowed write failures instead of a broken readiness panel for
 * every project in the deployment.
 */
async function resolveOrganizationCliConnected(
	organizationId: string,
): Promise<boolean> {
	const reaches: CliReachRecord[] = await db.organizationCliReach.findMany({
		where: { organizationId },
		select: { credentialKind: true, credentialId: true },
		// Newest-active first, and only so many — see CLI_REACH_READ_LIMIT for
		// what that trades away and why it is the right trade for a nudge.
		orderBy: { lastReachedAt: "desc" },
		take: CLI_REACH_READ_LIMIT,
	});

	const now = new Date();
	const idsOfKind = (kind: CliReachRecord["credentialKind"]): string[] =>
		reaches
			.filter((reach) => reach.credentialKind === kind)
			.map((reach) => reach.credentialId);

	const userKeyIds = idsOfKind("USER_API_KEY");
	const organizationKeyIds = idsOfKind("ORGANIZATION_API_KEY");

	/** A null expiry is a key that never expires, not a key that expired at epoch. */
	const unexpired = { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
	/**
	 * Offboarding kills the credential. Both hosts re-read membership on every
	 * request and answer 401 without it, so a key whose owner has left is a key
	 * that can no longer reach anything — the personal key through its holder,
	 * the organization key through the person who created it.
	 */
	const ownerStillAMember = { members: { some: { organizationId } } };

	const [aliveUserKey, aliveOrganizationKey] = await Promise.all([
		userKeyIds.length === 0
			? null
			: db.userApiKey.findFirst({
					where: {
						id: { in: userKeyIds },
						isActive: true,
						...unexpired,
						user: ownerStillAMember,
					},
					select: { id: true },
				}),
		organizationKeyIds.length === 0
			? null
			: db.organizationApiKey.findFirst({
					where: {
						id: { in: organizationKeyIds },
						isActive: true,
						...unexpired,
						createdBy: ownerStillAMember,
					},
					select: { id: true },
				}),
	]);

	// One surviving credential is enough; a dead one beside it changes nothing.
	return aliveUserKey !== null || aliveOrganizationKey !== null;
}

/**
 * The project's tenant columns, carried alongside the evidence so rows written
 * by the readiness procedures mirror their parent project's tenancy. Kept off
 * {@link ReadinessEvidence} deliberately — a detection rule has no business
 * seeing who owns the project.
 */
interface ProjectTenant {
	userId: string | null;
	organizationId: string | null;
}

/**
 * The project's own non-rule facts, carried on the same side channel as the
 * tenancy and for the same reason: no readiness rule may see them.
 *
 * Neither belongs in {@link ReadinessEvidence} — nothing grades a project on
 * being active or on what it is called, and a field on the evidence bundle is
 * an invitation for a rule to start. Both come off the row the gather has
 * already read by primary key, so carrying them costs nothing; asking for them
 * separately cost a second `findUnique` on that same row, on every readiness
 * read and every poll.
 */
interface ProjectFacts {
	/** Shown by the key-issuing view, which names the project it is for. */
	name: string;
	/** An archived project is never interrupted with a prompt (Fizzy #2457, R3). */
	status: ProjectStatus;
}

export interface ReadinessEvidenceResult {
	evidence: ReadinessEvidence;
	tenant: ProjectTenant;
	project: ProjectFacts;
	/**
	 * Whether the CLI-connection rollout gate is on for this project's
	 * organization (Fizzy #2457, R16).
	 *
	 * Resolved here because the gather is where it first pays for itself — it
	 * decides whether the connection evidence is worth reading at all — and
	 * returned so the read path spends one flag lookup rather than two, and
	 * cannot end up with two different answers to one question.
	 */
	cliNudgeEnabled: boolean;
}

export async function gatherReadinessEvidence(
	projectId: string,
): Promise<ReadinessEvidenceResult | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			userId: true,
			organizationId: true,
			// Neither is evidence — see `ProjectFacts`. They ride on this read
			// because the alternative was a second `findUnique` on this very
			// row, by the same primary key, a few lines later in the caller.
			name: true,
			status: true,
			projectPhase: true,
			description: true,
			expectedDevelopmentStartDate: true,
			features: true,
			techStack: true,
			projectManagementMcpServerId: true,
			autoPushPmSync: true,
			readOnlyMode: true,
			pmAutoCloseEnabled: true,
			pmTerminalStatuses: true,
			teamsChannelMonitorEnabled: true,
			teamsChatMonitorEnabled: true,
			slackChannelMonitorEnabled: true,
			meetingTranscriptAutoAnalyzeEnabled: true,
			repositoryUrl: true,
			codeAnalysisStatus: true,
			// NOT the organization's CLI reach records (Fizzy #2457, R2, R16).
			//
			// They used to ride in here, as a nested select, to save a round
			// trip. That quietly made the ENTIRE readiness surface — every read
			// and every mutation that gathers evidence — depend on
			// `organization_cli_reach` existing, for every organization, gate
			// or no gate. Deploy application code ahead of the migration, or
			// run any mixed-version window where the schema lags, and readiness
			// fails wholesale rather than losing one row.
			//
			// It also contradicted the gate itself. The point of resolving
			// CLI_CONNECTION_NUDGE before the reads, rather than discarding
			// their results afterwards, is that a gated-off organization does
			// no CLI work at all. A select on this row is CLI work.
			//
			// So the reach rows are fetched separately, after the gate is known
			// to be on, and never otherwise. Do not fold them back onto this
			// query for the round trip: the cost is one hop on the enabled path
			// only, that hop runs inside the parallel gather below, and what it
			// buys is that a schema lag can no longer take the readiness
			// surface down with it. The write path is a separate question and
			// is deliberately ungated — see `resolveOrganizationCliConnected`.
		},
	});
	if (!project) {
		return null;
	}

	/**
	 * The CLI-connection rollout gate (Fizzy #2457, R16).
	 *
	 * Resolved against the PROJECT'S organization, which is the whole point of
	 * the read: the flag is org-scopable and off by default, so a call passing
	 * no organization would answer a deployment-wide question instead of this
	 * organization's, and defeat a rollout meant to run one organization at a
	 * time.
	 *
	 * Read HERE, before the gather, so that "off" is cheap rather than merely
	 * invisible. Off is the state of essentially every organization while the
	 * rollout runs, and everything the feature reads — the reach read and the
	 * two key-table lookups below, and the two viewer lookups in the read path
	 * — was being issued and then discarded. One cached flag read now stands in
	 * front of all five. It costs a serial hop ahead of the parallel gather
	 * only when the ten-second flag cache misses.
	 *
	 * Nothing above this line may touch a CLI table. The project select
	 * deliberately does not, which is what makes "off" mean the tables are
	 * never asked for rather than merely asked for in vain.
	 */
	const cliNudgeEnabled = await isFeatureEnabled(
		"CLI_CONNECTION_NUDGE",
		project.organizationId ?? undefined,
	);

	const [
		contextGroups,
		knowledgeBaseLinkCount,
		documentGroups,
		acceptedMemberCount,
		roadmapItemCount,
		successfulScan,
		newsletter,
		atlasAnalysis,
		activeRepositoryIntegrations,
		completedCodeIndex,
		extractingContexts,
		indexingCodeIndex,
		generatingDocumentTypes,
		runningScan,
		linkedSlackChannelCount,
		linkedTeamsChannelCount,
		linkedTeamsChatCount,
		organizationCliConnected,
	] = await Promise.all([
		// Indexed context sources, grouped by kind so one read serves four rules.
		db.projectContext.groupBy({
			by: ["type"],
			where: { projectId, extractionStatus: INDEXED },
			_count: { _all: true },
		}),
		// The Knowledge Base rule needs the category, not just the kind.
		db.projectContext.count({
			where: {
				projectId,
				type: "LINK",
				extractionStatus: INDEXED,
				knowledgeBaseSourceCategory: "KNOWLEDGE_BASE_WIKI",
			},
		}),
		// Only documents that are active AND usable — plus the one case where a
		// transient status hides a document the project genuinely has.
		//
		// Regeneration mutates the SAME row: `markDocumentGenerationStarted`
		// writes it GENERATING, and a run that fails leaves it FAILED. Keying
		// only on status therefore dropped a long-satisfied PRD the moment its
		// owner hit Refresh, and left it dropped once the run failed — the
		// checklist offering "Create PRD" beside a Documents tab plainly showing
		// one. It cascades, too: `business-case` and `proposal` are superseded by
		// `prd` and `architecture` depends on it, so one status flip resurfaced
		// several rows at once.
		//
		// The content is what survives a failed re-run: the previous version is
		// still on the row, still active, still what retrieval reads. So a row
		// mid-rerun counts when it already holds content, and does not when it is
		// empty — a first-ever generation has nothing yet, which is exactly when
		// the item should read In Progress rather than done. Same shape as the
		// code-index read below keying on `lastFullIndexAt` rather than status.
		db.projectDocument.groupBy({
			by: ["type"],
			where: {
				projectId,
				isActive: true,
				OR: [
					{ status: { in: [...USABLE_DOCUMENT_STATUSES] } },
					{
						status: { in: [...RERUNNING_DOCUMENT_STATUSES] },
						content: { not: "" },
					},
				],
			},
			_count: { _all: true },
		}),
		// Pending invitations are not teammates yet.
		db.projectMember.count({
			where: { projectId, acceptedAt: { not: null } },
		}),
		db.userStory.count({ where: { projectId } }),
		db.projectScan.findFirst({
			where: { projectId, status: "COMPLETED" },
			select: { id: true },
		}),
		db.newsletterSettings.findUnique({
			where: { projectId },
			select: { enabled: true },
		}),
		db.atlasAnalysis.findFirst({
			where: { projectId },
			select: { id: true },
		}),
		// The CURRENT way a repository is attached. `Project.repositoryUrl` is the
		// legacy column and is null on projects connected through this path, so
		// reading only that reported "codebase not connected" on projects that
		// plainly had one — and silently hid Atlas, security and release notes,
		// which all depend on it.
		//
		// Only ACTIVE counts: a TOKEN_EXPIRED / ERROR / DISCONNECTED integration
		// is a codebase Fabric cannot currently read, which is what the item is
		// really asking about.
		db.projectRepositoryIntegration.count({
			where: { projectId, status: "ACTIVE" },
		}),
		// Whether the codebase has ever been indexed end to end.
		//
		// `Project.codeAnalysisStatus` is the legacy signal and is null on
		// projects indexed through this path — the same shape of mistake as the
		// legacy repository column beside it, and it was still reporting
		// "codebase not connected" after that one was fixed.
		//
		// Keyed on `lastFullIndexAt` rather than `status` deliberately: status
		// flips to INDEXING during every refresh, so a status check would make a
		// long-satisfied item blink back to incomplete each time the repository
		// re-indexes. A full index having completed once is the durable fact the
		// checklist is actually asking about.
		db.projectCodeIndex.findFirst({
			where: { projectId, lastFullIndexAt: { not: null } },
			select: { id: true },
		}),
		// ── In-flight work ───────────────────────────────────────────────
		// Everything below answers "is this already happening?" rather than
		// "did it work?". An item is only ever In Progress while incomplete.
		db.projectContext.findMany({
			where: {
				projectId,
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
			},
			select: { type: true, knowledgeBaseSourceCategory: true },
		}),
		db.projectCodeIndex.findFirst({
			where: { projectId, status: { in: ["PENDING", "INDEXING"] } },
			select: { id: true },
		}),
		// QUEUED counts as in flight alongside GENERATING: the request was
		// accepted and is waiting on its dependencies, which is work already
		// happening from the user's side. Reading only GENERATING would leave a
		// queued document neither ready nor in progress — the checklist would
		// offer "Create PRD" for a PRD that is already on its way.
		db.projectDocument.findMany({
			where: {
				projectId,
				isActive: true,
				status: { in: ["QUEUED", "GENERATING"] },
			},
			select: { type: true },
		}),
		db.projectScan.findFirst({
			where: { projectId, status: { in: ["PENDING", "RUNNING"] } },
			select: { id: true },
		}),
		// ── Linked chat surfaces ─────────────────────────────────────────
		// The durable fact behind "a chat app is connected". Counted rather
		// than read off a monitor flag: linking a channel is what connects the
		// app, and the flag only decides whether Fabric watches it continuously.
		db.projectLinkedSlackChannel.count({ where: { projectId } }),
		db.projectLinkedTeamsChannel.count({ where: { projectId } }),
		db.projectLinkedTeamsChat.count({ where: { projectId } }),
		// ── Is a CLI reaching this organization? (Fizzy #2457, R2) ───────
		// The reach records and the two key lookups, joining the gather
		// rather than following it — and only where the answer can be used.
		// With the rollout gate off the row is withheld from the checklist
		// entirely, so nothing downstream reads this fact: not asking is not
		// merely cheaper, it is what keeps the new CLI tables out of the
		// readiness path for an organization the feature is off for.
		//
		// R24: a project with no organization resolves false WITHOUT a
		// lookup. That branch is a fail-closed default reached only when
		// something failed to resolve a tenant — a defect to log, not a
		// context to support — so it is answered here rather than being
		// allowed to ask a question with a null in it.
		!cliNudgeEnabled || project.organizationId === null
			? false
			: resolveOrganizationCliConnected(project.organizationId),
	]);

	const contextCountByType = new Map<string, number>(
		contextGroups.map((row) => [row.type as string, row._count._all]),
	);
	const countOf = (type: string): number => contextCountByType.get(type) ?? 0;

	// "At least one context source" spans several kinds — an uploaded file, plain
	// text, a meeting transcript, or a connected integration all qualify.
	const totalContext =
		countOf("FILE") +
		countOf("TEXT") +
		countOf("LINK") +
		countOf("DOCUMENT") +
		countOf("SPREADSHEET") +
		countOf("IMAGE") +
		countOf("INTEGRATION") +
		countOf("MEETING_TRANSCRIPT") +
		countOf("API_SPEC");

	const evidence: ReadinessEvidence = {
		phase: project.projectPhase,
		expectedDevelopmentStartDate: project.expectedDevelopmentStartDate,
		descriptionLength: project.description?.trim().length ?? 0,

		inFlight: {
			context: {
				total: extractingContexts.length,
				meetingTranscripts: extractingContexts.filter(
					(c) => c.type === "MEETING_TRANSCRIPT",
				).length,
				knowledgeBaseLinks: extractingContexts.filter(
					(c) =>
						c.type === "LINK" &&
						c.knowledgeBaseSourceCategory === "KNOWLEDGE_BASE_WIKI",
				).length,
				notionSources: extractingContexts.filter(
					(c) => c.type === "INTEGRATION",
				).length,
			},
			codebaseIndexing: indexingCodeIndex !== null,
			documentTypes: new Set(
				generatingDocumentTypes.map((d) => String(d.type)),
			),
			scan: runningScan !== null,
		},

		featureCount: project.features.length,
		techStackCount: project.techStack.length,

		indexedContext: {
			total: totalContext,
			meetingTranscripts: countOf("MEETING_TRANSCRIPT"),
			knowledgeBaseLinks: knowledgeBaseLinkCount,
			// Notion only for v1 — see the wiki rule in the registry for why
			// Confluence cannot satisfy an "indexed successfully" clause today.
			notionSources: countOf("INTEGRATION"),
		},

		chat: {
			linkedChannelCount:
				linkedSlackChannelCount +
				linkedTeamsChannelCount +
				linkedTeamsChatCount,
			slackChannelMonitorEnabled: project.slackChannelMonitorEnabled,
			teamsChannelMonitorEnabled: project.teamsChannelMonitorEnabled,
			teamsChatMonitorEnabled: project.teamsChatMonitorEnabled,
			transcriptAutoAnalyzeEnabled:
				project.meetingTranscriptAutoAnalyzeEnabled,
		},

		pm: {
			connected: project.projectManagementMcpServerId !== null,
			autoPushEnabled: project.autoPushPmSync,
			readOnlyMode: project.readOnlyMode,
			autoCloseEnabled: project.pmAutoCloseEnabled,
			terminalStatusCount: project.pmTerminalStatuses.length,
		},

		code: {
			// Either path counts. The legacy column stays in the check so older
			// projects that were connected before integrations existed do not
			// regress to "not connected".
			repositoryConnected:
				activeRepositoryIntegrations > 0 ||
				Boolean(project.repositoryUrl),
			// Either signal counts, for the same reason the connection check
			// accepts both paths: older projects carry the legacy status column.
			analysisCompleted:
				completedCodeIndex !== null ||
				project.codeAnalysisStatus === "COMPLETED",
			atlasAnalysisExists: atlasAnalysis !== null,
		},

		organizationCliConnected,

		completeDocumentTypes: new Set(documentGroups.map((row) => row.type)),

		acceptedMemberCount,
		roadmapItemCount,
		successfulScanExists: successfulScan !== null,
		newsletterEnabled: newsletter?.enabled ?? false,
	};

	return {
		evidence,
		tenant: {
			userId: project.userId,
			organizationId: project.organizationId,
		},
		project: { name: project.name, status: project.status },
		cliNudgeEnabled,
	};
}
