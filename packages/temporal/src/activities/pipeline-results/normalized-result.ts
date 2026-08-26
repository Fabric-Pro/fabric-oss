/**
 * The provider-agnostic shape every pipeline-result fetcher
 * normalizes to before ingestion. Modeled on the JUnit XML `<testcase>` element
 * — the common denominator across GitHub Actions, GitLab CI, Azure DevOps Test
 * Runs, and Jira-Xray. Each per-provider fetcher (Phase 03) maps its native
 * payload to this; the linkage, status mapping, and persistence then operate on
 * this shape alone, so there is exactly one matcher and one sink regardless of
 * how many providers we ingest from.
 */

/** A single automated test's outcome within a run — JUnit `<testcase>`-shaped. */
export type NormalizedTestResult = {
	/**
	 * The test name — JUnit `<testcase name>`. Typically the `it()` / `test()`
	 * title or, in some reporters, the fully-qualified test method name.
	 */
	name: string;
	/**
	 * The suite / class — JUnit `<testcase classname>`. Typically the
	 * `describe()` block or the spec file. Used by the linkage cascade.
	 */
	classname?: string;
	/**
	 * The provider's RAW per-test outcome token (e.g. "passed", "Failed",
	 * "NotExecuted"). Mapped to a Fabric `TestResult` by the status mapper — kept
	 * raw here so the mapping is one shared, testable step, not repeated per
	 * fetcher.
	 */
	rawStatus: string;
	durationMs?: number;
	/** First failure / error message, when the test did not pass. */
	failureMessage?: string;
};

/** One ingested CI run and the per-test results it produced. */
export type NormalizedRun = {
	provider: string;
	externalRunId: string;
	pipelineName?: string;
	branch?: string;
	commitSha?: string;
	runUrl?: string;
	/** Raw run-level status (informational; per-test results are authoritative). */
	status?: string;
	/**
	 * Who triggered the CI run on the provider — GitHub `triggering_actor.login`,
	 * GitLab pipeline `user.username`, ADO run `requestedBy.displayName`. The
	 * human "run by X", distinct from the Fabric user the *sync* is attributed to.
	 * Undefined when the provider payload doesn't carry it.
	 */
	triggeredByActor?: string;
	/** Avatar URL for {@link triggeredByActor}, when the provider exposes one. */
	triggeredByActorAvatarUrl?: string;
	startedAt?: Date;
	finishedAt?: Date;
	durationMs?: number;
	results: NormalizedTestResult[];
};
