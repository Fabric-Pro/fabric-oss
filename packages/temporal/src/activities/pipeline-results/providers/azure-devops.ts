/**
 * Azure DevOps pipeline-results mapper.
 *
 * PURE module: imports NOTHING at runtime (type-only import of the shared
 * contract) so the deterministic ingest path can normalize an ADO Test Run
 * payload from one source of truth. Calls NO API and touches NO Prisma — the
 * thin activity that FETCHES the runs/results feeds this transform its raw JSON.
 *
 * Maps the Azure DevOps Test Runs REST shape to the provider-agnostic
 * `NormalizedRun[]`:
 *   - runs   ← GET {org}/{project}/_apis/test/runs
 *   - results ← GET {org}/{project}/_apis/test/Runs/{runId}/results
 * Each result's ADO `outcome` (Passed/Failed/Blocked/NotExecuted/…) is passed
 * through RAW as `rawStatus`; the shared `status-mapper` converts it to a Fabric
 * `TestResult` later, so the mapping stays one shared, tested step. The forward
 * direction (Fabric → ADO outcome) lives in
 * `pm-integration/test-execution-serializer.ts`.
 */

import type { NormalizedRun, NormalizedTestResult } from "../normalized-result";

/** This mapper's `NormalizedRun.provider` tag. */
export const AZURE_DEVOPS_PROVIDER = "azure-devops";

/** A ShallowReference (build/plan/owner) as returned inline by the ADO API. */
export interface AdoShallowReference {
	id?: string;
	name?: string;
	url?: string;
}

/** Build configuration recorded against a run — carries branch + commit. */
export interface AdoBuildConfiguration {
	id?: number;
	/** Branch the build ran on — e.g. "refs/heads/main". */
	branchName?: string;
	/** Source version / first commit the build was triggered on. */
	sourceVersion?: string;
	number?: string;
	flavor?: string;
	platform?: string;
}

/**
 * An Azure DevOps Test Run (GET {org}/{project}/_apis/test/runs). Only the
 * fields this mapper reads are modeled; the run also carries stat rollups
 * (totalTests, passedTests, …) that the per-test results supersede.
 */
export interface AdoTestRun {
	id: number;
	name?: string;
	/** Run lifecycle state — "Completed" | "InProgress" | "Aborted" | … */
	state?: string;
	startedDate?: string;
	completedDate?: string;
	build?: AdoShallowReference;
	buildConfiguration?: AdoBuildConfiguration;
	webAccessUrl?: string;
	totalTests?: number;
	passedTests?: number;
	/**
	 * The identity that owns / requested the run — ADO's "who ran" for a Test
	 * Run. An IdentityRef; `displayName` is the human name. Present on the run
	 * detail the fetcher already pulls.
	 */
	owner?: { displayName?: string; imageUrl?: string } | null;
}

/**
 * An Azure DevOps Test Result
 * (GET {org}/{project}/_apis/test/Runs/{runId}/results). One automated test's
 * outcome within a run.
 */
export interface AdoTestResult {
	id?: number;
	/** "Name of test" — the human-readable case title. */
	testCaseTitle?: string;
	/** "Fully qualified name of test executed" — preferred as the test name. */
	automatedTestName?: string;
	/** "Container to which test belongs" — the test file / dll (JUnit classname). */
	automatedTestStorage?: string;
	/**
	 * ADO outcome vocabulary: Passed | Failed | Blocked | NotExecuted | Warning |
	 * Error | NotApplicable | Aborted | Inconclusive | None. Passed through raw.
	 */
	outcome?: string;
	durationInMs?: number;
	errorMessage?: string;
}

/** ISO string → Date, or undefined for missing / unparseable input. */
function toDate(value: string | undefined): Date | undefined {
	if (!value) {
		return undefined;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Map one ADO Test Result to the JUnit-shaped normalized result. */
function mapAdoResult(result: AdoTestResult): NormalizedTestResult {
	return {
		name: result.automatedTestName || result.testCaseTitle || "",
		...(result.automatedTestStorage
			? { classname: result.automatedTestStorage }
			: {}),
		// Raw ADO outcome — the shared status-mapper converts it, not us.
		rawStatus: result.outcome ?? "",
		...(result.durationInMs != null
			? { durationMs: result.durationInMs }
			: {}),
		...(result.errorMessage ? { failureMessage: result.errorMessage } : {}),
	};
}

/**
 * Map an Azure DevOps Test Runs payload (and its per-run results, keyed by the
 * String(runId)) to the provider-agnostic `NormalizedRun[]`. Pure transform: a
 * run with no results entry normalizes to `results: []`.
 */
export function mapAzureDevOpsToNormalizedRuns(input: {
	runs: AdoTestRun[];
	resultsByRunId?: Record<string, AdoTestResult[]>;
}): NormalizedRun[] {
	const { runs, resultsByRunId } = input;

	return runs.map((run) => {
		const externalRunId = String(run.id);
		const results = resultsByRunId?.[externalRunId] ?? [];
		const branch = run.buildConfiguration?.branchName;
		const commitSha = run.buildConfiguration?.sourceVersion;
		const startedAt = toDate(run.startedDate);
		const finishedAt = toDate(run.completedDate);

		return {
			provider: AZURE_DEVOPS_PROVIDER,
			externalRunId,
			...(run.name ? { pipelineName: run.name } : {}),
			...(branch ? { branch } : {}),
			...(commitSha ? { commitSha } : {}),
			...(run.webAccessUrl ? { runUrl: run.webAccessUrl } : {}),
			...(run.state ? { status: run.state } : {}),
			...(run.owner?.displayName
				? { triggeredByActor: run.owner.displayName }
				: {}),
			...(run.owner?.imageUrl
				? { triggeredByActorAvatarUrl: run.owner.imageUrl }
				: {}),
			...(startedAt ? { startedAt } : {}),
			...(finishedAt ? { finishedAt } : {}),
			results: results.map(mapAdoResult),
		};
	});
}
