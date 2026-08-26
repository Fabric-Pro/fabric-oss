/**
 * Database queries for the Security & Accessibility Scanning feature.
 *
 * Models: ProjectScanConfig (1:1 per-project config + custom rule sets),
 * ProjectScan (one scan run), ScanFinding (individual findings).
 *
 * Tenant isolation: callers (oRPC procedures) gate access via
 * `hasProjectAccess` + permission middleware; writes carry userId/organizationId
 * so the `user_owned` RLS policy and the app-layer XOR filter both hold.
 */

import { db, type Prisma } from "../../client";
import type {
	FeatureDraftingStage,
	ScanActivityType,
	ScanCategory,
	ScanEnforcementMode,
	ScanFindingStatus,
	ScanMode,
	ScanSeverity,
	ScanStatus,
	ScanTargetType,
	ScanTrigger,
} from "../../generated/client";
import { orderStoriesBySemanticActivity } from "./story-semantic-activity";

// =============================================================================
// Custom rule sets (stored as JSON on ProjectScanConfig.customRules)
// =============================================================================

export type ScanCustomRule = {
	id: string;
	name: string;
	category: ScanCategory;
	severity: ScanSeverity;
	guidance: string;
	enabled: boolean;
};

/**
 * Safely parse the `customRules` JSON column into a typed array. Tolerates
 * null/legacy/malformed values by dropping anything that doesn't match the
 * expected shape, so a bad row never crashes a scan or the settings UI.
 */
export function parseScanCustomRules(
	value: Prisma.JsonValue | null,
): ScanCustomRule[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const rules: ScanCustomRule[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			continue;
		}
		const r = raw as Record<string, unknown>;
		if (
			typeof r.id === "string" &&
			typeof r.name === "string" &&
			(r.category === "SECURITY" || r.category === "ACCESSIBILITY") &&
			(r.severity === "CRITICAL" ||
				r.severity === "HIGH" ||
				r.severity === "MEDIUM" ||
				r.severity === "LOW") &&
			typeof r.guidance === "string"
		) {
			rules.push({
				id: r.id,
				name: r.name,
				category: r.category as ScanCategory,
				severity: r.severity as ScanSeverity,
				guidance: r.guidance,
				enabled: r.enabled !== false,
			});
		}
	}
	return rules;
}

// =============================================================================
// Severity rubric (stored as JSON on ProjectScanConfig.severityRubric)
// =============================================================================

/** One band of the editable severity rubric injected into the scanner prompt. */
export type ScanSeverityRubricEntry = {
	severity: ScanSeverity;
	definition: string;
};

/**
 * Seeded, CVSS-aligned defaults used whenever a project hasn't customized its
 * rubric. Keeps current behavior unchanged when the column is null, and gives
 * the prompt concrete band definitions to anchor severity assignment.
 */
export const DEFAULT_SEVERITY_RUBRIC: ScanSeverityRubricEntry[] = [
	{
		severity: "CRITICAL",
		definition:
			"Unauthenticated remote code execution, authentication bypass, mass exposure of PII or secrets, or a live secret committed to git history. Immediate, high-impact, low-barrier compromise.",
	},
	{
		severity: "HIGH",
		definition:
			"Authentication/authorization bypass in a specific context, stored XSS, SSRF reaching internal services, or injection without full RCE. Serious impact, exploitable with some constraints.",
	},
	{
		severity: "MEDIUM",
		definition:
			"Information disclosure, missing rate-limiting, weak cryptographic configuration, or a misconfiguration with limited blast radius. Real but bounded impact.",
	},
	{
		severity: "LOW",
		definition:
			"Defense-in-depth gaps, verbose error messages, missing security headers, or hardening recommendations. Minor impact or requires an unlikely precondition.",
	},
];

/**
 * Tolerant parser for the `severityRubric` JSON column. Mirrors
 * `parseScanCustomRules`: drops anything malformed so a bad row never crashes a
 * scan or the settings UI. Returns the seeded defaults when null/empty so the
 * scanner always has a rubric to inject.
 */
export function parseSeverityRubric(
	value: Prisma.JsonValue | null,
): ScanSeverityRubricEntry[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_SEVERITY_RUBRIC];
	}
	const entries: ScanSeverityRubricEntry[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			continue;
		}
		const r = raw as Record<string, unknown>;
		if (
			(r.severity === "CRITICAL" ||
				r.severity === "HIGH" ||
				r.severity === "MEDIUM" ||
				r.severity === "LOW") &&
			typeof r.definition === "string" &&
			r.definition.trim().length > 0 &&
			!seen.has(r.severity)
		) {
			seen.add(r.severity);
			entries.push({
				severity: r.severity as ScanSeverity,
				definition: r.definition.trim(),
			});
		}
	}
	return entries.length > 0 ? entries : [...DEFAULT_SEVERITY_RUBRIC];
}

// =============================================================================
// Knowledge packs (stored as JSON on ProjectScanConfig.securityKnowledgePacks)
// =============================================================================

/**
 * An attachable knowledge pack — richer security-review guidance appended to the
 * scanner prompt. Knowledge text only (never executed). `appliesTo` optionally
 * scopes a pack to one category; absent ⇒ applies to security (the default).
 */
export type ScanKnowledgePack = {
	id: string;
	title: string;
	content: string;
	appliesTo?: ScanCategory;
};

/**
 * Tolerant parser for the `securityKnowledgePacks` JSON column. Drops malformed
 * entries; an oversized `content` is capped so a pathological pack can't blow
 * the prompt budget.
 */
const MAX_KNOWLEDGE_PACK_CHARS = 8_000;

export function parseSecurityKnowledgePacks(
	value: Prisma.JsonValue | null,
): ScanKnowledgePack[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const packs: ScanKnowledgePack[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			continue;
		}
		const r = raw as Record<string, unknown>;
		if (
			typeof r.id === "string" &&
			typeof r.title === "string" &&
			typeof r.content === "string" &&
			r.content.trim().length > 0
		) {
			const content =
				r.content.length > MAX_KNOWLEDGE_PACK_CHARS
					? `${r.content.slice(0, MAX_KNOWLEDGE_PACK_CHARS)}\n…[truncated]`
					: r.content;
			packs.push({
				id: r.id,
				title: r.title,
				content,
				...(r.appliesTo === "SECURITY" ||
				r.appliesTo === "ACCESSIBILITY"
					? { appliesTo: r.appliesTo as ScanCategory }
					: {}),
			});
		}
	}
	return packs;
}

// =============================================================================
// Config
// =============================================================================

export const DEFAULT_SCAN_CONFIG = {
	securityEnabled: true,
	accessibilityEnabled: true,
	enforcementMode: "WARN" as ScanEnforcementMode,
	autoScanOnMaturation: true,
	maturationGate: "PUBLISHED" as FeatureDraftingStage,
	// Semgrep SAST is opt-in: it only runs when a repository is connected and
	// the toggle is explicitly enabled.
	semgrepEnabled: false,
	// Git-history secret scan is opt-in (heavier — full clone + gitleaks).
	gitHistoryEnabled: false,
	// Auto-run the AI false-positive review as the final scan phase (on by
	// default; best-effort — never fails or blanks a scan).
	autoReviewFindings: true,
};

/**
 * Findings below this confidence are hidden from the default findings view and
 * collapsed into a "low-confidence" bucket (nothing is deleted). This is a
 * DETERMINISTIC, zero-LLM-cost gate: it hides the noisy audit tail on its own,
 * and holds even when the AI review is off / failed / out of credits. The AI
 * false-positive judge only REFINES this baseline (auto-dismissing likely FPs,
 * or lifting a confirmed finding's confidence so it stays visible). Mirrored in
 * the web layer (`confidenceLevel`'s 0.5 boundary) — keep the two in sync.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Repo-engine `ruleSource` prefixes. A Semgrep finding's `location` is `path:line`
 * so it participates in code-path carry-forward; a git-history secret's location
 * embeds a file path too, but its finding must NEVER be dropped by a changed path
 * (gitleaks DIFF mode won't re-detect a pre-base secret, so dropping it loses the
 * finding AND its triage). The two engines are told apart by these prefixes, which
 * mirror the `ruleSource` strings built in semgrep-scan.ts / git-history-scan.ts.
 * Shared by `carryForwardFindings` and `scanEngineWhere` (one source of truth).
 */
const SEMGREP_RULE_PREFIX = "Semgrep:";
const GIT_HISTORY_RULE_PREFIX = "Secret history:";

/**
 * Normalize a user-entered scan branch to its stored form: trim surrounding
 * whitespace and collapse an empty / whitespace-only value to `null` (⇒ "use the
 * repository's default branch"). `undefined` is preserved as `undefined` so a
 * partial config update that omits the field leaves the stored value untouched.
 * Pure + exported for unit testing.
 */
export function normalizeScanBranch(
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export type ResolvedScanConfig = {
	projectId: string;
	exists: boolean;
	securityEnabled: boolean;
	accessibilityEnabled: boolean;
	enforcementMode: ScanEnforcementMode;
	autoScanOnMaturation: boolean;
	maturationGate: FeatureDraftingStage;
	semgrepEnabled: boolean;
	gitHistoryEnabled: boolean;
	/** Auto-run the AI false-positive review at the end of a scan (default on). */
	autoReviewFindings: boolean;
	/**
	 * Which branch the repo-based scanners clone/scan. Null ⇒ fall back to the
	 * repository's default branch (current behavior).
	 */
	scanBranch: string | null;
	customRules: ScanCustomRule[];
	/** Editable severity rubric (seeded CVSS-aligned defaults when none saved). */
	severityRubric: ScanSeverityRubricEntry[];
	/** Optional attachable knowledge packs appended to the security prompt. */
	securityKnowledgePacks: ScanKnowledgePack[];
	updatedAt: Date | null;
};

/**
 * Get scan config for a project, returning sensible defaults (security +
 * accessibility on, WARN mode) when none has been saved yet. The severity
 * rubric always resolves to the seeded defaults when unset so the scanner has a
 * rubric to inject without changing current behavior.
 */
export async function getProjectScanConfig(
	projectId: string,
): Promise<ResolvedScanConfig> {
	const config = await db.projectScanConfig.findUnique({
		where: { projectId },
	});
	if (!config) {
		return {
			projectId,
			exists: false,
			...DEFAULT_SCAN_CONFIG,
			maturationGate: DEFAULT_SCAN_CONFIG.maturationGate ?? "PUBLISHED",
			scanBranch: null,
			customRules: [],
			severityRubric: [...DEFAULT_SEVERITY_RUBRIC],
			securityKnowledgePacks: [],
			updatedAt: null,
		};
	}
	return {
		projectId,
		exists: true,
		securityEnabled: config.securityEnabled,
		accessibilityEnabled: config.accessibilityEnabled,
		enforcementMode: config.enforcementMode,
		autoScanOnMaturation: config.autoScanOnMaturation,
		maturationGate: config.maturationGate,
		semgrepEnabled: config.semgrepEnabled,
		gitHistoryEnabled: config.gitHistoryEnabled,
		autoReviewFindings: config.autoReviewFindings,
		scanBranch: config.scanBranch ?? null,
		customRules: parseScanCustomRules(config.customRules),
		severityRubric: parseSeverityRubric(config.severityRubric),
		securityKnowledgePacks: parseSecurityKnowledgePacks(
			config.securityKnowledgePacks,
		),
		updatedAt: config.updatedAt,
	};
}

/**
 * Create or update scan config. Tenant fields are required for RLS / XOR.
 */
export async function upsertProjectScanConfig(
	projectId: string,
	data: {
		securityEnabled?: boolean;
		accessibilityEnabled?: boolean;
		enforcementMode?: ScanEnforcementMode;
		autoScanOnMaturation?: boolean;
		maturationGate?: FeatureDraftingStage;
		semgrepEnabled?: boolean;
		gitHistoryEnabled?: boolean;
		autoReviewFindings?: boolean;
		/** Branch the repo scanners target; empty/whitespace normalizes to null. */
		scanBranch?: string | null;
		customRules?: ScanCustomRule[];
		severityRubric?: ScanSeverityRubricEntry[];
		securityKnowledgePacks?: ScanKnowledgePack[];
		userId: string;
		organizationId?: string | null;
	},
): Promise<ResolvedScanConfig> {
	// Normalize the branch once: undefined ⇒ leave untouched on update / default
	// to null on create; a blank/whitespace-only value collapses to null.
	const normalizedBranch = normalizeScanBranch(data.scanBranch);
	const customRulesJson =
		data.customRules === undefined
			? undefined
			: (data.customRules as unknown as Prisma.InputJsonValue);
	const severityRubricJson =
		data.severityRubric === undefined
			? undefined
			: (data.severityRubric as unknown as Prisma.InputJsonValue);
	const knowledgePacksJson =
		data.securityKnowledgePacks === undefined
			? undefined
			: (data.securityKnowledgePacks as unknown as Prisma.InputJsonValue);

	await db.projectScanConfig.upsert({
		where: { projectId },
		create: {
			projectId,
			securityEnabled:
				data.securityEnabled ?? DEFAULT_SCAN_CONFIG.securityEnabled,
			accessibilityEnabled:
				data.accessibilityEnabled ??
				DEFAULT_SCAN_CONFIG.accessibilityEnabled,
			enforcementMode:
				data.enforcementMode ?? DEFAULT_SCAN_CONFIG.enforcementMode,
			autoScanOnMaturation:
				data.autoScanOnMaturation ??
				DEFAULT_SCAN_CONFIG.autoScanOnMaturation,
			maturationGate:
				data.maturationGate ?? DEFAULT_SCAN_CONFIG.maturationGate,
			semgrepEnabled:
				data.semgrepEnabled ?? DEFAULT_SCAN_CONFIG.semgrepEnabled,
			gitHistoryEnabled:
				data.gitHistoryEnabled ?? DEFAULT_SCAN_CONFIG.gitHistoryEnabled,
			autoReviewFindings:
				data.autoReviewFindings ??
				DEFAULT_SCAN_CONFIG.autoReviewFindings,
			scanBranch: normalizedBranch ?? null,
			...(customRulesJson !== undefined && {
				customRules: customRulesJson,
			}),
			...(severityRubricJson !== undefined && {
				severityRubric: severityRubricJson,
			}),
			...(knowledgePacksJson !== undefined && {
				securityKnowledgePacks: knowledgePacksJson,
			}),
			userId: data.userId,
			organizationId: data.organizationId ?? null,
		},
		update: {
			...(data.securityEnabled !== undefined && {
				securityEnabled: data.securityEnabled,
			}),
			...(data.accessibilityEnabled !== undefined && {
				accessibilityEnabled: data.accessibilityEnabled,
			}),
			...(data.enforcementMode !== undefined && {
				enforcementMode: data.enforcementMode,
			}),
			...(data.autoScanOnMaturation !== undefined && {
				autoScanOnMaturation: data.autoScanOnMaturation,
			}),
			...(data.maturationGate !== undefined && {
				maturationGate: data.maturationGate,
			}),
			...(data.semgrepEnabled !== undefined && {
				semgrepEnabled: data.semgrepEnabled,
			}),
			...(data.gitHistoryEnabled !== undefined && {
				gitHistoryEnabled: data.gitHistoryEnabled,
			}),
			...(data.autoReviewFindings !== undefined && {
				autoReviewFindings: data.autoReviewFindings,
			}),
			// Only touch scanBranch when the caller provided it (undefined ⇒ leave
			// the stored value as-is); a blank value writes null.
			...(data.scanBranch !== undefined && {
				scanBranch: normalizedBranch ?? null,
			}),
			...(customRulesJson !== undefined && {
				customRules: customRulesJson,
			}),
			...(severityRubricJson !== undefined && {
				severityRubric: severityRubricJson,
			}),
			...(knowledgePacksJson !== undefined && {
				securityKnowledgePacks: knowledgePacksJson,
			}),
		},
	});

	return getProjectScanConfig(projectId);
}

// =============================================================================
// Scan runs
// =============================================================================

export async function createProjectScan(data: {
	projectId: string;
	storyId?: string | null;
	trigger: ScanTrigger;
	targetType: ScanTargetType;
	mode?: ScanMode;
	securityRequested: boolean;
	accessibilityRequested: boolean;
	/** Git branch the repo scanners run against (resolved by the caller). */
	branch?: string | null;
	userId: string;
	organizationId?: string | null;
}) {
	return db.projectScan.create({
		data: {
			projectId: data.projectId,
			storyId: data.storyId ?? null,
			status: "PENDING",
			trigger: data.trigger,
			targetType: data.targetType,
			mode: data.mode ?? "FULL",
			securityRequested: data.securityRequested,
			accessibilityRequested: data.accessibilityRequested,
			branch: data.branch ?? null,
			userId: data.userId,
			organizationId: data.organizationId ?? null,
		},
	});
}

/**
 * The `completedAt` of the most recent COMPLETED scan for a project (optionally
 * scoped to a feature / target type), excluding a given scan. Drives the
 * INCREMENTAL "changed since last scan" window. Null ⇒ no prior completed scan.
 */
export async function getLastCompletedScanAt(
	projectId: string,
	opts: {
		storyId?: string | null;
		targetType?: ScanTargetType;
		excludeScanId?: string;
		/**
		 * Scope the window to scans that ran against this branch, so an
		 * INCREMENTAL scan's "changed since" is measured per-branch. Provided
		 * (incl. `null` for no-repo scans) ⇒ filter; omitted ⇒ any branch.
		 */
		branch?: string | null;
	} = {},
): Promise<Date | null> {
	const scan = await db.projectScan.findFirst({
		where: {
			projectId,
			status: "COMPLETED",
			...(opts.storyId ? { storyId: opts.storyId } : {}),
			...(opts.targetType ? { targetType: opts.targetType } : {}),
			...(opts.excludeScanId ? { id: { not: opts.excludeScanId } } : {}),
			...(opts.branch !== undefined ? { branch: opts.branch } : {}),
		},
		orderBy: { completedAt: "desc" },
		select: { completedAt: true },
	});
	return scan?.completedAt ?? null;
}

/**
 * Copy still-relevant findings from the previous completed scan into the current
 * (incremental) scan, for items that were NOT re-scanned this run. Preserves
 * every field — status, severity/category overrides, and work-item links — so a
 * quick scan keeps the complete picture without re-analysing unchanged items. A
 * prior finding is dropped only when this run superseded it — its planning item
 * was re-scanned, it's a Semgrep finding on a re-scanned code path, or its
 * fingerprint is already in the fresh set — so git-history secrets always carry
 * forward. Returns the carried counts by category.
 */
/**
 * True when a finding's item was re-scanned this run (so the fresh findings
 * supersede it and it must NOT be carried forward). Matches the item key
 * (feature identifier / document title) inside the finding's `location`. Pure +
 * exported for unit testing.
 */
export function findingWasRescanned(
	location: string | null,
	scannedItemKeys: string[],
): boolean {
	const loc = location ?? "";
	return scannedItemKeys.some((k) => k.length > 0 && loc.includes(k));
}

/**
 * True when a Semgrep finding's `location` (`path:line`, or a bare `path`) sits on
 * a code file that was re-scanned this run. Match is EXACT on the path segment —
 * NOT a substring — so a changed `app.ts` never drops a finding at `app.ts.snap:3`.
 * Only used for Semgrep findings (the caller gates on the ruleSource prefix); a
 * git-history secret's location embeds a path too but must never be dropped this
 * way. Pure + exported for unit testing.
 */
export function codePathWasRescanned(
	location: string | null,
	rescannedCodePaths: string[],
): boolean {
	const loc = location ?? "";
	if (!loc) {
		return false;
	}
	return rescannedCodePaths.some(
		(p) => p.length > 0 && (loc === p || loc.startsWith(`${p}:`)),
	);
}

export async function carryForwardFindings(
	currentScanId: string,
	projectId: string,
	opts: {
		storyId?: string | null;
		targetType?: ScanTargetType;
		scannedItemKeys: string[];
		/**
		 * Repo-relative paths the code scan re-scanned this run (Semgrep DIFF). A
		 * Semgrep finding on one of these paths is superseded by the fresh scan and
		 * dropped; git-history + planning findings are NEVER dropped by a code path.
		 * Kept SEPARATE from `scannedItemKeys` (a substring match there would wrongly
		 * drop a git-history secret whose location embeds a changed file path).
		 */
		rescannedCodePaths?: string[];
		/**
		 * Fingerprints the current scan already persisted. A carried finding whose
		 * fingerprint is in this set was re-produced by this run (e.g. a full-scan
		 * fallback under INCREMENTAL), so carrying it would double-insert the row and
		 * inflate the finding count — drop it. Omitted ⇒ no fresh-set dedup (legacy).
		 */
		freshFingerprints?: Set<string>;
		/**
		 * The current scan's branch. When provided (incl. `null`), the "previous
		 * completed scan" is scoped to the SAME branch so branch A's scan never
		 * carries branch B's findings forward. Omitted ⇒ any branch (legacy).
		 */
		branch?: string | null;
	},
): Promise<{ security: number; accessibility: number; total: number }> {
	const previous = await db.projectScan.findFirst({
		where: {
			projectId,
			status: "COMPLETED",
			id: { not: currentScanId },
			...(opts.storyId
				? { storyId: opts.storyId }
				: { targetType: opts.targetType ?? "PROJECT" }),
			...(opts.branch !== undefined ? { branch: opts.branch } : {}),
		},
		orderBy: { completedAt: "desc" },
		select: { id: true },
	});
	if (!previous) {
		return { security: 0, accessibility: 0, total: 0 };
	}

	const prior = await db.scanFinding.findMany({
		where: { scanId: previous.id },
	});
	const rescannedCodePaths = opts.rescannedCodePaths ?? [];
	// Keep a prior finding unless this run superseded it, by ANY of:
	//   (a) its planning item (feature id / document title) was re-scanned, OR
	//   (b) it's a Semgrep finding whose exact code path was re-scanned, OR
	//   (c) this run already re-produced it (fingerprint present in the fresh set).
	// Git-history secrets match neither (a) nor (b), so they always carry forward.
	const carry = prior.filter((f) => {
		if (findingWasRescanned(f.location, opts.scannedItemKeys)) {
			return false;
		}
		if (
			(f.ruleSource ?? "").startsWith(SEMGREP_RULE_PREFIX) &&
			codePathWasRescanned(f.location, rescannedCodePaths)
		) {
			return false;
		}
		if (
			opts.freshFingerprints &&
			f.fingerprint &&
			opts.freshFingerprints.has(f.fingerprint)
		) {
			return false;
		}
		return true;
	});
	if (carry.length === 0) {
		return { security: 0, accessibility: 0, total: 0 };
	}

	await db.scanFinding.createMany({
		data: carry.map((f) => ({
			scanId: currentScanId,
			projectId: f.projectId,
			storyId: f.storyId,
			category: f.category,
			severity: f.severity,
			title: f.title,
			description: f.description,
			remediation: f.remediation,
			ruleSource: f.ruleSource,
			isCustomRule: f.isCustomRule,
			location: f.location,
			sourceUrl: f.sourceUrl,
			evidence: f.evidence,
			status: f.status,
			confidence: f.confidence,
			fingerprint: f.fingerprint,
			firstDetectedAt: f.firstDetectedAt,
			userId: f.userId,
			organizationId: f.organizationId,
		})),
	});
	const security = carry.filter((f) => f.category === "SECURITY").length;
	return {
		security,
		accessibility: carry.length - security,
		total: carry.length,
	};
}

/**
 * Prior triage carried by fingerprint, for the cross-scan carry-forward at
 * persist time. A "prior finding" is the most-recent finding (across the
 * project's earlier scans) for each fingerprint — so a recurring finding keeps
 * the status / firstDetectedAt / (re-scan only) severity the user already set,
 * instead of resurfacing as a fresh OPEN row.
 */
export type PriorFindingTriage = {
	status: ScanFindingStatus;
	severity: ScanSeverity;
	firstDetectedAt: Date | null;
	createdAt: Date;
};

/**
 * Build a fingerprint → latest-prior-triage map for a project, excluding the
 * current scan. Pure DB read; the persist activity decides what to carry. Only
 * findings that actually carry a fingerprint participate (legacy rows are null).
 * The newest row per fingerprint wins (findings are scanned newest-first).
 */
export async function getPriorFindingTriageByFingerprint(
	projectId: string,
	opts: { excludeScanId?: string; fingerprints?: string[] } = {},
): Promise<Map<string, PriorFindingTriage>> {
	const fingerprints = (opts.fingerprints ?? []).filter(
		(f): f is string => typeof f === "string" && f.length > 0,
	);
	// When the caller passes the fresh fingerprints, scope the query to them —
	// far cheaper than scanning the whole finding history on a large project.
	const prior = await db.scanFinding.findMany({
		where: {
			projectId,
			fingerprint:
				fingerprints.length > 0
					? { in: Array.from(new Set(fingerprints)) }
					: { not: null },
			...(opts.excludeScanId
				? { scanId: { not: opts.excludeScanId } }
				: {}),
		},
		select: {
			fingerprint: true,
			status: true,
			severity: true,
			firstDetectedAt: true,
			createdAt: true,
		},
		orderBy: { createdAt: "desc" },
	});
	const byFingerprint = new Map<string, PriorFindingTriage>();
	for (const f of prior) {
		if (!f.fingerprint || byFingerprint.has(f.fingerprint)) {
			// First (newest) row per fingerprint wins — skip older duplicates.
			continue;
		}
		byFingerprint.set(f.fingerprint, {
			status: f.status,
			severity: f.severity,
			firstDetectedAt: f.firstDetectedAt,
			createdAt: f.createdAt,
		});
	}
	return byFingerprint;
}

/**
 * Tenant-scoped delete of a project's OPEN findings — the "purge" half of a
 * purge re-scan (G10). RESOLVED / DISMISSED rows are preserved (their triage is
 * the user's record and the re-scan still carries their status forward by
 * fingerprint). Scoped by projectId + the tenant XOR so a delete can never cross
 * a tenant boundary. Returns the number of rows deleted.
 */
export async function deleteOpenProjectScanFindings(
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
): Promise<number> {
	// Scope to project + tenant, NOT to the acting user. In a shared org project
	// OPEN findings may have been created by different members' scans (each row
	// carries its scan-runner's userId), and a purge re-scan must clear ALL of the
	// project's current findings — matching the project-scoped read/update the
	// rest of the feature uses (`listScanFindings`/`updateScanFinding` filter by
	// projectId, never userId). organizationId keeps the bulk delete tenant-safe.
	const result = await db.scanFinding.deleteMany({
		where: {
			projectId,
			status: "OPEN",
			organizationId: tenant.organizationId ?? null,
		},
	});
	return result.count;
}

export async function updateProjectScan(
	scanId: string,
	data: Prisma.ProjectScanUpdateInput,
) {
	return db.projectScan.update({ where: { id: scanId }, data });
}

/**
 * Compare-and-set cancel: flip the scan to FAILED ONLY if it is still active
 * (PENDING / RUNNING). Returns the number of rows updated — 0 means the scan
 * already reached a terminal state (e.g. the workflow's persist won the race and
 * wrote COMPLETED between the caller's status read and here), so the caller must
 * treat the cancel as a no-op rather than overwrite a COMPLETED row — and its
 * persisted findings — as FAILED. Also makes a double-click cancel idempotent:
 * the second call updates 0 rows.
 */
export async function failScanIfActive(
	scanId: string,
	projectId: string,
	error: string,
): Promise<number> {
	const res = await db.projectScan.updateMany({
		where: {
			id: scanId,
			projectId,
			status: { in: ["PENDING", "RUNNING"] },
		},
		data: { status: "FAILED", error, completedAt: new Date() },
	});
	return res.count;
}

export async function getProjectScan(scanId: string, projectId: string) {
	return db.projectScan.findFirst({ where: { id: scanId, projectId } });
}

/**
 * Most-recent scan for a project (optionally scoped to a feature, and/or to a
 * given status). Drives the page's "last scan" summary + polling, and — with
 * `status: "COMPLETED"` — the default scoping for the findings list so a
 * re-scan replaces the displayed results instead of stacking on top of them.
 */
export async function getLatestProjectScan(
	projectId: string,
	opts: {
		storyId?: string | null;
		status?: ScanStatus;
		/**
		 * Scope to scans that ran against this branch — drives the branch-aware
		 * results view + "last scan" summary. Provided (incl. `null`) ⇒ filter;
		 * omitted ⇒ the latest scan regardless of branch (current behavior).
		 */
		branch?: string | null;
	} = {},
) {
	return db.projectScan.findFirst({
		where: {
			projectId,
			...(opts.storyId ? { storyId: opts.storyId } : {}),
			...(opts.status ? { status: opts.status } : {}),
			...(opts.branch !== undefined ? { branch: opts.branch } : {}),
		},
		orderBy: { createdAt: "desc" },
		// Include the user who triggered the scan so the page can show "started
		// by <name>" alongside the live running-scan timer.
		include: {
			user: {
				select: { id: true, name: true, email: true, image: true },
			},
		},
	});
}

export async function listProjectScans(
	projectId: string,
	opts: { limit?: number } = {},
) {
	return db.projectScan.findMany({
		where: { projectId },
		orderBy: { createdAt: "desc" },
		take: Math.min(opts.limit ?? 20, 100),
	});
}

// =============================================================================
// Findings
// =============================================================================

export async function createScanFindings(
	findings: Prisma.ScanFindingCreateManyInput[],
) {
	if (findings.length === 0) {
		return { count: 0 };
	}
	return db.scanFinding.createMany({ data: findings });
}

/**
 * The four scan engines, used by the findings-table engine filter (G12). Each
 * maps to a `ScanFinding` where-clause: the AI engines are SECURITY/ACCESSIBILITY
 * findings whose ruleSource is NOT a repo-engine prefix; Semgrep + git-history
 * are identified by their ruleSource prefix ("Semgrep: " / "Secret history: ").
 */
export type ScanEngineFilter =
	| "AI_SECURITY"
	| "AI_ACCESSIBILITY"
	| "SEMGREP"
	| "GIT_HISTORY";

/**
 * Translate an engine filter into a `ScanFinding` where-clause fragment. Pure +
 * exported so the mapping is unit-tested directly (no DB).
 */
export function scanEngineWhere(
	engine: ScanEngineFilter,
): Prisma.ScanFindingWhereInput {
	switch (engine) {
		case "SEMGREP":
			return {
				category: "SECURITY",
				ruleSource: { startsWith: SEMGREP_RULE_PREFIX },
			};
		case "GIT_HISTORY":
			return {
				category: "SECURITY",
				ruleSource: { startsWith: GIT_HISTORY_RULE_PREFIX },
			};
		case "AI_SECURITY":
			// LLM security findings = SECURITY category, NOT a repo-engine prefix.
			return {
				category: "SECURITY",
				NOT: {
					OR: [
						{ ruleSource: { startsWith: SEMGREP_RULE_PREFIX } },
						{ ruleSource: { startsWith: GIT_HISTORY_RULE_PREFIX } },
					],
				},
			};
		case "AI_ACCESSIBILITY":
			return { category: "ACCESSIBILITY" };
	}
}

export async function listScanFindings(
	projectId: string,
	filters: {
		category?: ScanCategory;
		severity?: ScanSeverity;
		status?: ScanFindingStatus;
		storyId?: string;
		scanId?: string;
		/** Engine filter (G12) — translated to ruleSource/category clauses. */
		scanner?: ScanEngineFilter;
		/** Sort key (G1). Defaults to recency. */
		sort?: "severity" | "confidence";
		/**
		 * Confidence-band filter for the deterministic default view. `minConfidence`
		 * keeps findings at/above the floor (the shown set); `maxConfidence` keeps
		 * those below it (the collapsed low-confidence bucket). A row with a NULL
		 * confidence (legacy) is treated as above the floor so it's never hidden by
		 * `minConfidence`, and excluded by `maxConfidence`.
		 */
		minConfidence?: number;
		maxConfidence?: number;
		limit?: number;
	} = {},
) {
	// The DB fetch order — and therefore WHICH rows survive the `take` cap on a
	// >500-finding scan — ALWAYS prioritises severity, then confidence, then
	// recency, INDEPENDENT of the requested display sort. A Postgres enum orders
	// by its declared order (CRITICAL, HIGH, MEDIUM, LOW), so `severity: "asc"`
	// is CRITICAL-first. This guarantees the cap can only ever drop the
	// lowest-signal rows (low-severity + low-confidence + oldest) — never a real
	// HIGH/CRITICAL finding evicted by a flood of low-confidence audit noise. The
	// requested DISPLAY order is then applied in-code below over the kept rows.
	const orderBy: Prisma.ScanFindingOrderByWithRelationInput[] = [
		{ severity: "asc" },
		{ confidence: "desc" },
		{ createdAt: "desc" },
	];

	const rows = await db.scanFinding.findMany({
		where: {
			projectId,
			...(filters.category && { category: filters.category }),
			...(filters.severity && { severity: filters.severity }),
			...(filters.status && { status: filters.status }),
			...(filters.storyId && { storyId: filters.storyId }),
			...(filters.scanId && { scanId: filters.scanId }),
			...(filters.scanner ? scanEngineWhere(filters.scanner) : {}),
			// At/above the floor OR null (legacy rows never hidden by the floor).
			...(filters.minConfidence !== undefined && {
				OR: [
					{ confidence: { gte: filters.minConfidence } },
					{ confidence: null },
				],
			}),
			// Strictly below the floor — the collapsed low-confidence bucket. A
			// null confidence is NOT below the floor, so it's excluded here.
			...(filters.maxConfidence !== undefined && {
				confidence: { lt: filters.maxConfidence },
			}),
		},
		// Include the source feature's blocked state so a finding can show
		// "Block F-XXX" or a "Blocked → F-XXX" chip (with the reason).
		include: {
			story: {
				select: {
					id: true,
					identifier: true,
					blocked: true,
					blockedReason: true,
				},
			},
		},
		orderBy,
		// Default to the 500 hard cap, not 200: a single scan can persist ~400-500
		// findings (200-item projects × security+accessibility), and the Security
		// page sends no explicit limit — a 200 default silently hid ~half the
		// findings from the list AND undercounted the status summary.
		take: Math.min(filters.limit ?? 500, 500),
	});

	// Apply the requested DISPLAY order in-code, over the severity-safe kept set.
	// (The DB fetch order above is fixed so the take cap never drops an important
	// finding; here we only reorder what's already been fetched.)
	if (filters.sort === "severity") {
		const rank: Record<string, number> = {
			CRITICAL: 4,
			HIGH: 3,
			MEDIUM: 2,
			LOW: 1,
		};
		return [...rows].sort((a, b) => {
			const diff = (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
			if (diff !== 0) {
				return diff;
			}
			return b.createdAt.getTime() - a.createdAt.getTime();
		});
	}
	if (filters.sort === "confidence") {
		return [...rows].sort((a, b) => {
			const diff = (b.confidence ?? 0) - (a.confidence ?? 0);
			if (diff !== 0) {
				return diff;
			}
			return b.createdAt.getTime() - a.createdAt.getTime();
		});
	}

	// Default: recency (newest first) across the kept set.
	return [...rows].sort(
		(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
	);
}

// =============================================================================
// Activity / history — global "what happened on this page" log
// =============================================================================

export async function recordScanActivity(data: {
	projectId: string;
	type: ScanActivityType;
	userId: string;
	organizationId?: string | null;
	scanId?: string | null;
	findingId?: string | null;
	storyId?: string | null;
	summary?: string | null;
	metadata?: Prisma.InputJsonValue;
}) {
	return db.scanActivity.create({
		data: {
			projectId: data.projectId,
			type: data.type,
			userId: data.userId,
			organizationId: data.organizationId ?? null,
			scanId: data.scanId ?? null,
			findingId: data.findingId ?? null,
			storyId: data.storyId ?? null,
			summary: data.summary ?? null,
			...(data.metadata !== undefined && { metadata: data.metadata }),
		},
	});
}

export async function listScanActivity(
	projectId: string,
	opts: {
		limit?: number;
		type?: ScanActivityType;
		/** Filter to a set of types (e.g. all scan-run types, or finding types). */
		types?: ScanActivityType[];
	} = {},
) {
	return db.scanActivity.findMany({
		where: {
			projectId,
			...(opts.type ? { type: opts.type } : {}),
			...(opts.types && opts.types.length > 0
				? { type: { in: opts.types } }
				: {}),
		},
		include: {
			user: {
				select: { id: true, name: true, email: true, image: true },
			},
		},
		orderBy: { createdAt: "desc" },
		take: Math.min(opts.limit ?? 50, 200),
	});
}

export async function getScanFinding(findingId: string, projectId: string) {
	return db.scanFinding.findFirst({ where: { id: findingId, projectId } });
}

/**
 * Map feature identifiers (F-XXX / B-XXX) to their UserStory ids within a
 * project — used to link an LLM finding to the feature it's about, so the UI can
 * render an in-app "view feature" link. Missing identifiers are simply absent.
 */
export async function getStoryIdsByIdentifiers(
	projectId: string,
	identifiers: string[],
): Promise<Record<string, string>> {
	if (identifiers.length === 0) {
		return {};
	}
	const stories = await db.userStory.findMany({
		where: { projectId, identifier: { in: identifiers } },
		select: { id: true, identifier: true },
	});
	return Object.fromEntries(stories.map((s) => [s.identifier, s.id]));
}

/**
 * Update a finding's mutable triage fields — status, category, and/or severity.
 * Only the fields present in `data` are written, so callers can patch any
 * subset. Scoped by `projectId` for tenant safety (matched alongside `id`).
 * Returns true when a row was updated.
 */
export async function updateScanFinding(
	findingId: string,
	projectId: string,
	data: {
		status?: ScanFindingStatus;
		category?: ScanCategory;
		severity?: ScanSeverity;
		/**
		 * Derived confidence (0..1). The auto-review lifts a judge-CONFIRMED
		 * finding's confidence to/above the floor so it stays in the default view
		 * even when the scanner rated it low.
		 */
		confidence?: number;
	},
): Promise<boolean> {
	const patch: Prisma.ScanFindingUpdateManyMutationInput = {};
	if (data.status !== undefined) {
		patch.status = data.status;
	}
	if (data.category !== undefined) {
		patch.category = data.category;
	}
	if (data.severity !== undefined) {
		patch.severity = data.severity;
	}
	if (data.confidence !== undefined) {
		patch.confidence = data.confidence;
	}
	if (Object.keys(patch).length === 0) {
		return false;
	}
	const result = await db.scanFinding.updateMany({
		where: { id: findingId, projectId },
		data: patch,
	});
	return result.count > 0;
}

// =============================================================================
// Scan content assembly (the "what gets scanned" — Fabric-held context)
// =============================================================================

/**
 * High safety ceilings. These are NOT the old aggressive coverage caps (28k
 * total / 4k per item / 40 features / 20 docs) — those silently dropped ~83% of
 * a large project's content. Chunked + parallel scanning (G3) reads every item;
 * these guards only stop a single pathological item, or a runaway item count,
 * from blowing up the worker. When either trips we LOG it and report a count so
 * nothing is silently dropped.
 */
const MAX_SINGLE_ITEM_CHARS = 16_000;
const MAX_TOTAL_ITEMS = 200;

function capItem(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_SINGLE_ITEM_CHARS) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, MAX_SINGLE_ITEM_CHARS)}\n…[truncated]`,
		truncated: true,
	};
}

/** One discrete unit of scan content (project meta / a feature / a document). */
export type ScanContentItem = {
	/** Stable key for carry-forward attribution (feature id / document title). */
	key: string;
	/** Human label shown to the model ("Feature F-123 (...)", "Document (...): T"). */
	label: string;
	/** The item's prose (already capped at the single-item safety ceiling). */
	text: string;
};

export type ScanContent = {
	projectName: string;
	/**
	 * Discrete items to scan — project meta as one item, each feature, each
	 * active document. The runScan activity chunks these (respecting item
	 * boundaries) and scans the chunks with bounded parallelism, so there is no
	 * single-blob coverage cap. Empty when the project has no content.
	 */
	items: ScanContentItem[];
	itemCount: number;
	/**
	 * Keys (feature identifiers + document titles) of the items actually included
	 * in this scan. Drives incremental carry-forward: findings on items NOT in
	 * this set are carried forward from the previous scan unchanged. Project meta
	 * is NOT a carry-forward key (it has no findings tied to it by location).
	 */
	scannedItemKeys: string[];
	/**
	 * How many items were dropped by the total-items ceiling (0 in the normal
	 * case). Surfaced + logged so a truncated scan never reads as full coverage.
	 */
	truncatedItemCount: number;
};

/**
 * Assemble the Fabric-held content a scan should analyse, as DISCRETE ITEMS:
 *   - the project's name/goals/tech stack for context (one "project meta" item),
 *   - the feature's text (FEATURE scope) OR every non-declined feature (PROJECT),
 *   - active generated documents (PROJECT scope) — the "feature documents"
 *     whose described UI the accessibility agent inspects.
 *
 * Each item is clearly labelled so the LLM can attribute a finding to its source
 * (e.g. "Feature F-123" / "Document: Architecture Spec"). Coverage is full (no
 * per-blob truncation); only the high single-item / total-item safety ceilings
 * apply, and any truncation is counted + logged.
 */
export async function getProjectScanContent(
	projectId: string,
	opts: {
		storyId?: string | null;
		targetType: ScanTargetType;
		/** FULL (default) scans everything; INCREMENTAL only changed items. */
		mode?: ScanMode;
		/**
		 * For INCREMENTAL PROJECT scans: include only items updated after this
		 * timestamp (the previous completed scan). Null ⇒ no prior scan, so an
		 * incremental scan effectively covers everything (first run).
		 */
		sinceCompletedAt?: Date | null;
	},
): Promise<ScanContent> {
	// Incremental filtering only applies to a project-wide scan with a prior
	// completed run; a feature-scoped scan always re-reads its one feature.
	const incrementalSince =
		opts.mode === "INCREMENTAL" && !opts.storyId && opts.sinceCompletedAt
			? opts.sinceCompletedAt
			: null;
	const scannedItemKeys: string[] = [];
	const items: ScanContentItem[] = [];

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			name: true,
			description: true,
			goals: true,
			techStack: true,
		},
	});

	if (project) {
		const meta: string[] = [`Project: ${project.name}`];
		if (project.description) {
			meta.push(`Description: ${project.description}`);
		}
		if (project.goals) {
			meta.push(`Goals: ${project.goals}`);
		}
		if (project.techStack?.length) {
			meta.push(`Tech stack: ${project.techStack.join(", ")}`);
		}
		// Project meta is context, not a finding-bearing item — no carry-forward
		// key. Cap it like any item to bound a pathological description.
		items.push({
			key: "__project_meta__",
			label: "Project context",
			text: capItem(meta.join("\n")).text,
		});
	}

	// Features (one for FEATURE scope, every non-declined feature for PROJECT
	// scope — no `take` cap; coverage is full and chunked downstream).
	const storyRows = await db.userStory.findMany({
		where: {
			projectId,
			...(opts.storyId
				? { id: opts.storyId }
				: { draftingStage: { notIn: ["DECLINED"] } }),
			...(incrementalSince
				? {
						OR: [
							{ createdAt: { gt: incrementalSince } },
							{ lastEditedAt: { gt: incrementalSince } },
						],
					}
				: {}),
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			kind: true,
			description: true,
			acceptanceCriteria: true,
			releaseNotes: true,
			createdAt: true,
			lastEditedAt: true,
		},
		...(opts.storyId ? { take: 1 } : {}),
	});
	// The total-items ceiling below decides which features get scanned at all, so
	// the order has to be true activity. A compound `lastEditedAt desc nulls
	// last, createdAt desc` would rank EVERY edited feature above every
	// never-edited one, so a feature added today would be dropped in favour of
	// one last touched two years ago.
	const stories = orderStoriesBySemanticActivity(storyRows);

	for (const s of stories) {
		const label = `Feature ${s.identifier} (${s.kind}): ${s.title}`;
		const parts = [`### ${label}`];
		if (s.description) {
			parts.push(`Description: ${s.description}`);
		}
		if (s.acceptanceCriteria) {
			parts.push(`Acceptance criteria: ${s.acceptanceCriteria}`);
		}
		if (s.releaseNotes) {
			parts.push(`Release notes: ${s.releaseNotes}`);
		}
		items.push({
			key: s.identifier,
			label,
			text: capItem(parts.join("\n")).text,
		});
		scannedItemKeys.push(s.identifier);
	}

	// Generated documents (PROJECT scope only) — their described UI feeds the
	// accessibility agent (AC2), and any code snippets feed the security agent.
	// No `take` cap; coverage is full.
	if (!opts.storyId) {
		const documents = await db.projectDocument.findMany({
			where: {
				projectId,
				isActive: true,
				...(incrementalSince
					? { updatedAt: { gt: incrementalSince } }
					: {}),
			},
			select: { title: true, type: true, content: true },
			orderBy: { updatedAt: "desc" },
		});
		for (const d of documents) {
			const label = `Document (${d.type}): ${d.title}`;
			items.push({
				key: d.title,
				label,
				text: capItem(`### ${label}\n${d.content}`).text,
			});
			scannedItemKeys.push(d.title);
		}
	}

	// Total-items safety ceiling. Keep project meta + the most-recent story edits
	// items (the query already ordered desc); drop the overflow and COUNT it so
	// the activity can log "scanned X of Y items" — never a silent cap.
	let truncatedItemCount = 0;
	let finalItems = items;
	if (items.length > MAX_TOTAL_ITEMS) {
		truncatedItemCount = items.length - MAX_TOTAL_ITEMS;
		finalItems = items.slice(0, MAX_TOTAL_ITEMS);
		// Re-derive the carry-forward keys from the kept finding-bearing items.
		scannedItemKeys.length = 0;
		for (const item of finalItems) {
			if (item.key !== "__project_meta__") {
				scannedItemKeys.push(item.key);
			}
		}
	}

	return {
		projectName: project?.name ?? "Project",
		items: finalItems,
		itemCount: finalItems.length,
		scannedItemKeys,
		truncatedItemCount,
	};
}

/**
 * Is there already a non-terminal scan for this project/feature? Used to dedupe
 * the maturation-gate auto-trigger so a flurry of stage changes can't spawn a
 * pile of redundant scans. Optionally scoped to a branch so a per-branch bulk
 * trigger dedupes per branch (a scan on `master` doesn't block one on `develop`).
 */
export async function hasActiveScan(
	projectId: string,
	opts: { storyId?: string | null; branch?: string | null } = {},
): Promise<boolean> {
	const active = await db.projectScan.findFirst({
		where: {
			projectId,
			...(opts.storyId ? { storyId: opts.storyId } : {}),
			// Provided (incl. `null` for no-repo scans) ⇒ scope to that branch;
			// omitted ⇒ any branch (current behavior).
			...(opts.branch !== undefined ? { branch: opts.branch } : {}),
			status: { in: ["PENDING", "RUNNING"] },
		},
		select: { id: true },
	});
	return active !== null;
}

// =============================================================================
// Per-branch scan checkpoints (incremental / branch-scoped scanning)
// =============================================================================

/**
 * The scan checkpoint for a (project, branch), or null when the branch has never
 * had a completed scan. Drives the "changed since last scan" diff and the
 * branch-status panel's Scanned / Stale badge (live HEAD vs the stored commitSha).
 */
export async function getScanCheckpoint(projectId: string, branch: string) {
	return db.projectScanCheckpoint.findUnique({
		where: { projectId_branch: { projectId, branch } },
	});
}

/**
 * Every branch checkpoint for a project — one row per scanned branch. Powers the
 * branch-status join (each branch's last-scanned commit + timestamp).
 */
export async function listScanCheckpoints(projectId: string) {
	return db.projectScanCheckpoint.findMany({ where: { projectId } });
}

/**
 * Advance (or create) the checkpoint for a (project, branch) after a successful
 * scan. Tenant fields are required on create for RLS / XOR. Every call writes the
 * full advanced state — commit SHA, the scan that produced it, and the diff-scope
 * telemetry — so create and update carry the same fields. The branch is normalized
 * and must resolve to a concrete name; a checkpoint never tracks the null
 * "no-repo" case.
 */
export async function upsertScanCheckpoint(data: {
	projectId: string;
	branch: string;
	commitSha: string;
	lastScanId?: string | null;
	lastScannedAt: Date;
	changedFileCount?: number | null;
	changedCommitCount?: number | null;
	userId: string;
	organizationId?: string | null;
}) {
	const branch = normalizeScanBranch(data.branch);
	if (!branch) {
		throw new Error("upsertScanCheckpoint requires a concrete branch");
	}
	return db.projectScanCheckpoint.upsert({
		where: { projectId_branch: { projectId: data.projectId, branch } },
		create: {
			projectId: data.projectId,
			branch,
			commitSha: data.commitSha,
			lastScanId: data.lastScanId ?? null,
			lastScannedAt: data.lastScannedAt,
			changedFileCount: data.changedFileCount ?? null,
			changedCommitCount: data.changedCommitCount ?? null,
			userId: data.userId,
			organizationId: data.organizationId ?? null,
		},
		update: {
			commitSha: data.commitSha,
			lastScanId: data.lastScanId ?? null,
			lastScannedAt: data.lastScannedAt,
			changedFileCount: data.changedFileCount ?? null,
			changedCommitCount: data.changedCommitCount ?? null,
		},
	});
}
