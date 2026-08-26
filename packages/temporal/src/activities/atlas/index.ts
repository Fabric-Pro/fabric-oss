/**
 * Temporal activities for the Atlas workflow. Thin wrappers — every
 * one delegates to `AtlasService` (the facade), passing a heartbeat
 * callback so long activities (clone/build, AI describe) stay alive.
 */
import { AtlasService } from "@repo/atlas";
import { Context } from "@temporalio/activity";

interface TenantInput {
	userId: string;
	organizationId: string | null;
}

function service(input: TenantInput): AtlasService {
	return new AtlasService({
		userId: input.userId,
		organizationId: input.organizationId,
	});
}

function heartbeat(): () => void {
	return () => {
		Context.current().heartbeat();
	};
}

/**
 * Run `fn` while emitting a heartbeat every 20s, independent of what the work is
 * doing internally. This guarantees a long activity (git clone, large parse, an
 * AI batch) never goes silent past its heartbeat timeout — so big repos don't
 * false-timeout. The service's own per-phase heartbeats still fire too.
 */
async function withHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
	const timer = setInterval(() => {
		try {
			Context.current().heartbeat();
		} catch {
			// Outside an activity context / already settled — safe to ignore.
		}
	}, 20_000);
	try {
		return await fn();
	} finally {
		clearInterval(timer);
	}
}

export interface AtlasStructureResult {
	commitSha: string;
	commitAt: string | null;
	manifest: Record<string, string>;
	changedModuleKeys: string[];
	nodeCount: number;
	edgeCount: number;
	filesAnalyzed: number;
}

export async function atlasMarkStatusActivity(
	input: TenantInput & {
		analysisId: string;
		status: "ANALYZING" | "READY" | "FAILED";
		error?: string | null;
	},
): Promise<void> {
	await service(input).markStatus({
		analysisId: input.analysisId,
		status: input.status,
		error: input.error ?? null,
	});
}

export async function atlasRunStructureActivity(
	input: TenantInput & {
		analysisId: string;
		projectId: string;
		repositoryIntegrationId: string | null;
	},
): Promise<AtlasStructureResult> {
	if (!input.repositoryIntegrationId) {
		throw new Error("repositoryIntegrationId is required for analysis");
	}
	// Hand the Temporal activity cancellation signal to the (long, ~9GB)
	// clone/parse so a user "Cancel analysis" stops it promptly — aborting the
	// git subprocess and bailing between major steps — instead of running to its
	// 90-minute cap. The workflow proxies this activity with TRY_CANCEL, so the
	// signal flips as soon as the cancel is delivered. Guarded for non-activity
	// contexts (e.g. unit tests) where there is no Context.
	let abortSignal: AbortSignal | undefined;
	let activityAttempt: number | undefined;
	try {
		const context = Context.current();
		abortSignal = context.cancellationSignal;
		// Thread the Temporal attempt through so each retried run clones into its
		// OWN directory and never races a prior attempt's clone dir.
		activityAttempt = context.info.attempt;
	} catch {
		abortSignal = undefined;
		activityAttempt = undefined;
	}
	return withHeartbeat(() =>
		service(input).runStructureAnalysis({
			analysisId: input.analysisId,
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId as string,
			heartbeat: heartbeat(),
			abortSignal,
			activityAttempt,
		}),
	);
}

/** AI telemetry an activity returns so the workflow can sum it (T3). */
export interface AtlasAiTelemetry {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Canonical model name used by this activity, or null (no AI provider). */
	model: string | null;
	/** Best-effort reasoning text (B3), or null. */
	reasoning: string | null;
}

export async function atlasDescribeModulesActivity(
	input: TenantInput & {
		analysisId: string;
		projectId?: string;
		changedModuleKeys: string[];
		/** "From fresh" (B5) — do not feed user overrides into the prompts. */
		fresh?: boolean;
	},
): Promise<{ described: number; requested: number } & AtlasAiTelemetry> {
	return withHeartbeat(async () => {
		const r = await service(input).describeChangedModules({
			analysisId: input.analysisId,
			projectId: input.projectId,
			changedModuleKeys: input.changedModuleKeys,
			fresh: input.fresh,
			heartbeat: heartbeat(),
		});
		return {
			described: r.described,
			requested: r.requested,
			promptTokens: r.usage.promptTokens,
			completionTokens: r.usage.completionTokens,
			totalTokens: r.usage.totalTokens,
			model: r.model,
			reasoning: r.reasoning,
		};
	});
}

export async function atlasDeriveBusinessActivity(
	input: TenantInput & {
		analysisId: string;
		projectId: string;
		incremental?: boolean;
		changedModuleKeys?: string[];
		/** "From fresh" (B5) — do not feed user overrides into the prompts. */
		fresh?: boolean;
	},
): Promise<{ capabilities: number } & AtlasAiTelemetry> {
	return withHeartbeat(async () => {
		const r = await service(input).deriveBusiness({
			analysisId: input.analysisId,
			projectId: input.projectId,
			incremental: input.incremental,
			changedModuleKeys: input.changedModuleKeys,
			fresh: input.fresh,
		});
		return {
			capabilities: r.capabilities,
			promptTokens: r.usage.promptTokens,
			completionTokens: r.usage.completionTokens,
			totalTokens: r.usage.totalTokens,
			model: r.model,
			reasoning: r.reasoning,
		};
	});
}

export async function atlasFinalizeActivity(
	input: TenantInput & {
		analysisId: string;
		status: "READY" | "FAILED";
		commitSha?: string | null;
		commitAt?: string | null;
		manifest?: Record<string, string> | null;
		nodeCount?: number;
		edgeCount?: number;
		filesAnalyzed?: number;
		modulesDescribed?: number;
		incremental?: boolean;
		branch?: string | null;
		fresh?: boolean;
		// Summed AI telemetry from the describe + business activities (T3).
		model?: string | null;
		promptTokens?: number | null;
		completionTokens?: number | null;
		totalTokens?: number | null;
		reasoning?: string | null;
		error?: string | null;
	},
): Promise<void> {
	await service(input).finalize({
		analysisId: input.analysisId,
		status: input.status,
		commitSha: input.commitSha,
		commitAt: input.commitAt,
		manifest: input.manifest,
		nodeCount: input.nodeCount,
		edgeCount: input.edgeCount,
		filesAnalyzed: input.filesAnalyzed,
		modulesDescribed: input.modulesDescribed,
		incremental: input.incremental,
		branch: input.branch,
		fresh: input.fresh,
		model: input.model,
		promptTokens: input.promptTokens,
		completionTokens: input.completionTokens,
		totalTokens: input.totalTokens,
		reasoning: input.reasoning,
		error: input.error,
	});
}
