import {
	type db,
	isPmServerIdKeySentinel,
	Prisma,
	readPmServerIdKeySentinel,
} from "@repo/database";
import {
	decideCandidate,
	deriveTrustedKey,
	extractConfigOrgKey,
	extractEntityOrgKey,
	mapKeyToPatternType,
	type PmPatternType,
	type TrustedKey,
} from "./pm-server-provenance-match";
import { belongsToDifferentKnownTool, safeHost } from "./pm-tool-mismatch";

type DbFull = typeof db;
type DbLike = Prisma.TransactionClient | DbFull;

/**
 * The only work-item table is `userStory` — the Epic/Feature folder tables
 * were dropped. The union keeps the legacy members for wire compatibility
 * with persisted payloads; new rows are always `"userStory"`.
 */
export type EntityTable = "epic" | "feature" | "userStory";

export interface ProjectRow {
	id: string;
	projectManagementMcpServerId: string | null;
	projectManagementMcpConfigId: string | null;
}

export interface LinkedRow {
	table: EntityTable;
	id: string;
	projectId: string;
	externalId: string;
	externalUrl: string | null;
	externalMcpServerId: string | null;
}

export type ResolveResult =
	| {
			ok: true;
			activeServerId: string;
			toolType: PmPatternType;
			configOrgKey: string | null;
	  }
	| { ok: false; reason: "no-config" | "unsupported-tooltype" };

export async function resolveProjectPmTarget(
	client: DbLike,
	project: ProjectRow,
): Promise<ResolveResult> {
	const activeServerId = project.projectManagementMcpServerId;
	if (!activeServerId) {
		return { ok: false, reason: "no-config" };
	}

	let toolType: ReturnType<typeof mapKeyToPatternType>;
	let defaultUrl: string | null = null;

	if (isPmServerIdKeySentinel(activeServerId)) {
		// Degraded mode (e.g. GitLab REST): no catalog MCPServer row exists. The
		// server key is encoded in the sentinel ("key:<key>"), and the sentinel
		// value itself is what the poll's guard compares against — so it is also
		// what we stamp (activeServerId stays the sentinel string).
		toolType = mapKeyToPatternType(
			readPmServerIdKeySentinel(activeServerId),
		);
	} else {
		const server = await client.mCPServer.findUnique({
			where: { id: activeServerId },
			select: { key: true, defaultUrl: true },
		});
		if (!server) {
			return { ok: false, reason: "no-config" };
		}
		toolType = mapKeyToPatternType(server.key);
		defaultUrl = server.defaultUrl ?? null;
	}
	if (!toolType) {
		return { ok: false, reason: "unsupported-tooltype" };
	}

	let commandArgs: string[] | null = null;
	let baseUrl: string | null = null;
	let atlassianCloudSiteUrl: string | null = null;

	if (project.projectManagementMcpConfigId) {
		const cfg = await client.mCPConfig.findUnique({
			where: { id: project.projectManagementMcpConfigId },
			select: {
				baseUrl: true,
				commandArgs: true,
				atlassianCloudSiteUrl: true,
				mcpServer: { select: { defaultUrl: true } },
			},
		});
		if (cfg) {
			commandArgs = cfg.commandArgs ?? null;
			baseUrl = cfg.baseUrl ?? null;
			atlassianCloudSiteUrl = cfg.atlassianCloudSiteUrl ?? null;
			defaultUrl = cfg.mcpServer?.defaultUrl ?? defaultUrl;
		}
	}

	const configOrgKey = extractConfigOrgKey(toolType, {
		commandArgs,
		baseUrl,
		defaultUrl,
		atlassianCloudSiteUrl,
	});
	return { ok: true, activeServerId, toolType, configOrgKey };
}

export async function loadProjectLinks(
	client: DbLike,
	projectId: string,
): Promise<LinkedRow[]> {
	const stories = await client.userStory.findMany({
		where: { projectId, externalId: { not: null } },
		select: {
			id: true,
			externalId: true,
			externalUrl: true,
			externalMcpServerId: true,
		},
	});
	return stories.map((r) => ({
		table: "userStory" as const,
		id: r.id,
		projectId, // all rows came from WHERE projectId = projectId; re-asserted at apply time
		externalId: r.externalId as string,
		externalUrl: r.externalUrl ?? null,
		externalMcpServerId: r.externalMcpServerId ?? null,
	}));
}

export type TrustedResolution =
	| {
			ok: true;
			activeServerId: string;
			toolType: PmPatternType;
			trusted: TrustedKey;
			links: LinkedRow[];
	  }
	| { ok: false; reason: "no-config" | "unsupported-tooltype" };

export async function resolveTrusted(
	client: DbLike,
	project: ProjectRow,
): Promise<TrustedResolution> {
	const target = await resolveProjectPmTarget(client, project);
	if (!target.ok) {
		return target;
	}
	const links = await loadProjectLinks(client, project.id);
	// Independent baseline for the config-underivable fallback: ONLY rows already
	// stamped for the active server (provenance written by the live link path).
	// Unstamped candidates are never trusted to validate themselves.
	const baselineKeys = links
		.filter((r) => {
			if (r.externalMcpServerId !== target.activeServerId) {
				return false;
			}
			const h = r.externalUrl ? safeHost(r.externalUrl) : null;
			return h ? !belongsToDifferentKnownTool(h, target.toolType) : true;
		})
		.map((r) => extractEntityOrgKey(target.toolType, r.externalUrl));
	const trusted = deriveTrustedKey({
		configOrgKey: target.configOrgKey,
		baselineKeys,
	});
	return {
		ok: true,
		activeServerId: target.activeServerId,
		toolType: target.toolType,
		trusted,
		links,
	};
}

export interface StampMark {
	table: EntityTable;
	id: string;
	projectId: string;
	externalId: string;
	externalUrl: string | null;
}

export interface ProjectPlan {
	ok: true;
	activeServerId: string;
	toolType: PmPatternType;
	trusted: TrustedKey;
	marks: StampMark[];
	counts: Record<string, number>;
}

export type PlanResult =
	| ProjectPlan
	| { ok: false; reason: "no-config" | "unsupported-tooltype" };

export async function planProjectStamps(
	client: DbLike,
	project: ProjectRow,
): Promise<PlanResult> {
	const res = await resolveTrusted(client, project);
	if (!res.ok) {
		return res;
	}

	const counts: Record<string, number> = {};
	const bump = (k: string) => {
		counts[k] = (counts[k] ?? 0) + 1;
	};
	const marks: StampMark[] = [];

	for (const row of res.links) {
		if (row.externalMcpServerId != null) {
			continue; // not a candidate
		}
		const entityOrgKey = extractEntityOrgKey(res.toolType, row.externalUrl);
		const decision = decideCandidate({
			toolType: res.toolType,
			externalUrl: row.externalUrl,
			entityOrgKey,
			trusted: res.trusted,
		});
		if (decision.action === "stamp") {
			marks.push({
				table: row.table,
				id: row.id,
				projectId: row.projectId,
				externalId: row.externalId,
				externalUrl: row.externalUrl,
			});
		} else {
			bump(`skip:${decision.reason}`);
		}
	}

	return {
		ok: true,
		activeServerId: res.activeServerId,
		toolType: res.toolType,
		trusted: res.trusted,
		marks,
		counts,
	};
}

const MAX_APPLY_RETRIES = 3;

// P2034 is Prisma's documented retryable serialization/write-conflict code, carried as a direct .code on PrismaClientKnownRequestError. If a future driver-adapter wraps it, this check would also need to inspect e.cause.
function isSerializationError(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		(e as { code?: string }).code === "P2034"
	);
}

function trustedEquals(a: TrustedKey, b: TrustedKey): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	if (a.kind === "trusted" && b.kind === "trusted") {
		return a.key === b.key;
	}
	if (a.kind === "ambiguous" && b.kind === "ambiguous") {
		return a.reason === b.reason;
	}
	return true; // both "none"
}

async function updateRow(
	tx: DbLike,
	mark: StampMark,
	activeServerId: string,
): Promise<number> {
	const where = {
		id: mark.id,
		projectId: mark.projectId,
		externalId: mark.externalId,
		externalUrl: mark.externalUrl,
		externalMcpServerId: null,
	} as const;
	const data = { externalMcpServerId: activeServerId } as const;
	// Stories are the only work-item rows (folder tables dropped). A legacy
	// epic/feature mark can't match a user_story id, so it yields count 0 and
	// is reported as changed-since-snapshot.
	const result = await tx.userStory.updateMany({ where, data });
	return result.count;
}

export interface ApplyOutcome {
	stamped: number;
	changedSinceSnapshot: number;
	projectSkipped?: "project-config-changed" | "serialization-conflict";
}

export async function applyProjectStamps(
	client: DbFull,
	project: ProjectRow,
	plan: ProjectPlan,
): Promise<ApplyOutcome> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await client.$transaction(
				async (tx) => {
					// (a) Reload the LIVE project row by id, then revalidate provenance from
					// live state. Re-reading the row (not the planning snapshot) is what makes
					// a config switch between planning and apply observable inside the tx.
					const liveProject = await tx.project.findUnique({
						where: { id: project.id },
						select: {
							id: true,
							projectManagementMcpServerId: true,
							projectManagementMcpConfigId: true,
						},
					});
					if (!liveProject) {
						return {
							stamped: 0,
							changedSinceSnapshot: 0,
							projectSkipped: "project-config-changed" as const,
						};
					}
					const live = await resolveTrusted(tx, liveProject);
					if (
						!live.ok ||
						live.activeServerId !== plan.activeServerId ||
						!trustedEquals(live.trusted, plan.trusted)
					) {
						return {
							stamped: 0,
							changedSinceSnapshot: 0,
							projectSkipped: "project-config-changed" as const,
						};
					}
					// (b) Stamp each marked row, re-asserting its snapshot tuple.
					let stamped = 0;
					let changedSinceSnapshot = 0;
					for (const mark of plan.marks) {
						const n = await updateRow(
							tx,
							mark,
							plan.activeServerId,
						);
						if (n === 1) {
							stamped += 1;
						} else {
							changedSinceSnapshot += 1;
						}
					}
					return { stamped, changedSinceSnapshot };
				},
				{
					isolationLevel:
						Prisma.TransactionIsolationLevel.Serializable,
				},
			);
		} catch (e) {
			if (isSerializationError(e) && attempt < MAX_APPLY_RETRIES) {
				continue;
			}
			if (isSerializationError(e)) {
				return {
					stamped: 0,
					changedSinceSnapshot: 0,
					projectSkipped: "serialization-conflict",
				};
			}
			throw e;
		}
	}
}

export interface BackfillOptions {
	apply: boolean;
	projectId?: string;
}

export interface BackfillReport {
	projects: number;
	/** Planned stamps across projects that resolved successfully. In apply mode this is the planned count and may include marks for projects later skipped at apply time (config-changed / serialization-conflict); use `stamped` for rows actually written. */
	wouldStamp: number;
	stamped: number;
	totals: Record<string, number>;
}

export async function runBackfill(
	client: DbFull,
	opts: BackfillOptions,
	log: (message: string) => void,
): Promise<BackfillReport> {
	const projects = await client.project.findMany({
		where: {
			projectManagementMcpServerId: { not: null },
			...(opts.projectId ? { id: opts.projectId } : {}),
		},
		select: {
			id: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
		},
	});

	const totals: Record<string, number> = {};
	const bump = (k: string, n = 1) => {
		totals[k] = (totals[k] ?? 0) + n;
	};
	let wouldStamp = 0;
	let stamped = 0;

	for (const project of projects) {
		const plan = await planProjectStamps(client, project);
		if (!plan.ok) {
			bump(`skip:${plan.reason}`);
			log(`project ${project.id}: skipped (${plan.reason})`);
			continue;
		}
		for (const [k, v] of Object.entries(plan.counts)) {
			bump(k, v);
		}
		wouldStamp += plan.marks.length;

		if (!opts.apply) {
			log(`project ${project.id}: would stamp ${plan.marks.length}`);
			continue;
		}

		const outcome = await applyProjectStamps(client, project, plan);
		if (outcome.projectSkipped) {
			bump(`skip:${outcome.projectSkipped}`);
			log(`project ${project.id}: ${outcome.projectSkipped}`);
			continue;
		}
		stamped += outcome.stamped;
		if (outcome.changedSinceSnapshot) {
			bump("skip:changed-since-snapshot", outcome.changedSinceSnapshot);
		}
		log(
			`project ${project.id}: stamped ${outcome.stamped}` +
				(outcome.changedSinceSnapshot
					? `, ${outcome.changedSinceSnapshot} changed-since-snapshot`
					: ""),
		);
	}

	return { projects: projects.length, wouldStamp, stamped, totals };
}
