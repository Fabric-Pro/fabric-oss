/**
 * GitHub Actions pipeline-result fetcher. Pulls recent
 * completed workflow runs from a connected GitHub repo, downloads each run's
 * JUnit test-report artifact (GitHub has no per-test API — teams upload
 * `junit.xml` via `actions/upload-artifact`), parses it, and normalizes via the
 * shared GitHub mapper. Incremental: only runs newer than the stored cursor
 * (highest ingested run id) are fetched.
 *
 * GitHub REST access is injected as {@link GithubClient} so auth lives outside
 * this fetch (production wires a Bearer-token client; tests mock it). A run with
 * no matching / non-expired artifact still ingests as a run-level record with
 * `results: []` — the run's pass/fail is preserved even when per-test detail is
 * unavailable.
 */

import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import * as yauzl from "yauzl";
import { safeHeartbeat } from "../../lib/activity-liveness";
import type { NormalizedRun } from "../normalized-result";
import {
	type GithubWorkflowRun,
	type JUnitSuite,
	mapGithubActionsToNormalizedRuns,
} from "../providers/github-actions";
import { advanceCursor } from "./cursor";
import { parseJUnitXml } from "./junit-xml";
import { paginateRuns } from "./paginate";

/** Minimal GitHub REST access the fetcher needs. */
export interface GithubClient {
	get<T = unknown>(path: string): Promise<T>;
	/** Download an artifact zip; `null` when GitHub answers 410 (expired). */
	getArtifactZip(path: string): Promise<Uint8Array | null>;
}

export interface GithubFetchInput {
	owner: string;
	repo: string;
	/** Restrict to runs on this branch (the connected default branch), when set. */
	branch?: string;
	/** Incremental cursor: only runs with `id` greater than this are pulled. */
	sinceRunId?: number | null;
	/** How many recent runs to scan per fetch (the list is newest-first). */
	maxRuns?: number;
	/**
	 * Only download artifacts whose name matches — an exact name, or (default)
	 * the junit/test/report/result heuristic — so a run's build/coverage
	 * artifacts aren't pulled just to find the test report.
	 */
	artifactName?: string;
}

export interface GithubFetchResult {
	runs: NormalizedRun[];
	/** Highest run id seen — the caller stores it as the next cursor. */
	newCursor: number | null;
	/** True when the page cap stopped paging before reaching the cursor. */
	truncated?: boolean;
}

interface GithubRunsListResponse {
	workflow_runs?: GithubWorkflowRun[];
}

interface GithubArtifact {
	id: number;
	name: string;
	expired?: boolean;
	size_in_bytes?: number;
}

interface GithubArtifactsListResponse {
	artifacts?: GithubArtifact[];
}

/** Default artifact-name heuristic when no exact `artifactName` is configured. */
const DEFAULT_ARTIFACT_PATTERN = /junit|test|report|result/i;
/** Bound per-run work: never pull more than this many artifacts or oversized ones. */
const MAX_ARTIFACTS_PER_RUN = 5;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;
const MAX_XML_ENTRIES = 100;
const MAX_XML_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 20 * 1024 * 1024;

/** Does this artifact look like the run's test report? */
function isReportArtifact(
	artifact: GithubArtifact,
	exactName?: string,
): boolean {
	if (artifact.expired) {
		return false;
	}
	if (exactName) {
		return artifact.name === exactName;
	}
	return DEFAULT_ARTIFACT_PATTERN.test(artifact.name);
}

/** Unzip one artifact and parse every `*.xml` entry as JUnit → flat suites. */
function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (openError, stream) => {
			if (openError) {
				reject(openError);
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			const readable: Readable = stream;
			readable.on("data", (chunk: Buffer) => {
				total += chunk.byteLength;
				if (total > MAX_XML_ENTRY_BYTES) {
					readable.destroy(
						new Error("JUnit XML entry exceeds the size limit"),
					);
					return;
				}
				chunks.push(chunk);
			});
			readable.once("error", reject);
			readable.once("end", () => resolve(Buffer.concat(chunks, total)));
		});
	});
}

async function suitesFromArtifactZip(bytes: Uint8Array): Promise<JUnitSuite[]> {
	if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
		throw new Error("GitHub artifact exceeds the download limit");
	}

	return new Promise((resolve, reject) => {
		yauzl.fromBuffer(
			Buffer.from(bytes),
			{
				autoClose: true,
				lazyEntries: true,
				validateEntrySizes: true,
			},
			(openError, zip) => {
				if (openError) {
					reject(openError);
					return;
				}
				if (zip.entryCount > MAX_ZIP_ENTRIES) {
					zip.close();
					reject(
						new Error("GitHub artifact contains too many entries"),
					);
					return;
				}

				const suites: JUnitSuite[] = [];
				let xmlEntries = 0;
				let xmlBytes = 0;
				let settled = false;
				const fail = (error: Error) => {
					if (settled) {
						return;
					}
					settled = true;
					zip.close();
					reject(error);
				};

				zip.once("error", fail);
				zip.once("end", () => {
					if (!settled) {
						settled = true;
						resolve(suites);
					}
				});
				zip.on("entry", (entry: yauzl.Entry) => {
					if (!/\.xml$/i.test(entry.fileName)) {
						zip.readEntry();
						return;
					}
					xmlEntries += 1;
					xmlBytes += entry.uncompressedSize;
					if (
						xmlEntries > MAX_XML_ENTRIES ||
						entry.uncompressedSize > MAX_XML_ENTRY_BYTES ||
						xmlBytes > MAX_XML_TOTAL_BYTES
					) {
						fail(
							new Error(
								"GitHub artifact exceeds JUnit extraction limits",
							),
						);
						return;
					}

					void readZipEntry(zip, entry)
						.then((xml) => {
							suites.push(...parseJUnitXml(xml.toString("utf8")));
							zip.readEntry();
						})
						.catch(fail);
				});
				zip.readEntry();
			},
		);
	});
}

/**
 * Fetch + normalize new GitHub Actions runs. Lists recent completed runs, keeps
 * the ones past the cursor, downloads + parses each run's JUnit artifact(s), and
 * maps to `NormalizedRun`. Runs are returned oldest-first so ingestion order is
 * chronological and the cursor advances monotonically. A single run's artifact
 * failure is swallowed (that run ingests run-level-only) so one bad report never
 * fails the whole fetch.
 */
export async function fetchGithubActionsRuns(
	client: GithubClient,
	input: GithubFetchInput,
): Promise<GithubFetchResult> {
	const perPage = input.maxRuns ?? 20;
	const owner = encodeURIComponent(input.owner);
	const repo = encodeURIComponent(input.repo);
	const since = input.sinceRunId ?? 0;

	const branchParam = input.branch
		? `&branch=${encodeURIComponent(input.branch)}`
		: "";
	// Deliberately NOT `status=completed`: the runs still in progress are what
	// tells us how far the cursor may safely advance. Filtering them out
	// server-side made an older run that finishes later invisible forever.
	// Page back to the cursor: one newest-first page against a bigger backlog
	// loses everything below it the moment the cursor advances.
	const { items: allRuns, truncated } = await paginateRuns<GithubWorkflowRun>(
		{
			since,
			perPage,
			idOf: (r) => r.id,
			onPage: (page) => safeHeartbeat({ phase: "github-list", page }),
			fetchPage: async (page) => {
				const batch = await client.get<GithubRunsListResponse>(
					`/repos/${owner}/${repo}/actions/runs?per_page=${perPage}&page=${page}${branchParam}`,
				);
				return batch.workflow_runs ?? [];
			},
		},
	);

	const listed = allRuns.filter((r) => r.id > since);
	const candidates = listed
		.filter((r) => r.status === "completed")
		.sort((a, b) => a.id - b.id);
	const inFlightIds = listed
		.filter((r) => r.status !== "completed")
		.map((r) => r.id);

	const junitByRunId: Record<string, JUnitSuite[]> = {};
	const ingestedIds: number[] = [];

	for (const run of candidates) {
		// Each run can pull an artifact list plus multi-MB zips. Without a
		// check-in per run the activity can outlive its heartbeatTimeout while
		// doing exactly what it is supposed to.
		safeHeartbeat({ phase: "github-run", runId: run.id });
		try {
			const artifactsList = await client.get<GithubArtifactsListResponse>(
				`/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`,
			);
			const reports = (artifactsList.artifacts ?? [])
				.filter((a) => isReportArtifact(a, input.artifactName))
				.filter(
					(a) =>
						a.size_in_bytes === undefined ||
						a.size_in_bytes <= MAX_ARTIFACT_BYTES,
				)
				.slice(0, MAX_ARTIFACTS_PER_RUN);

			const suites: JUnitSuite[] = [];
			for (const artifact of reports) {
				const bytes = await client.getArtifactZip(
					`/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,
				);
				if (bytes) {
					suites.push(...(await suitesFromArtifactZip(bytes)));
				}
			}
			if (suites.length > 0) {
				junitByRunId[String(run.id)] = suites;
			}
		} catch (err) {
			// One run's artifact fetch/parse failing must not sink the whole sync;
			// the run still ingests as a run-level record (results: []).
			console.warn("[pipeline-github] artifact fetch failed for run", {
				owner: input.owner,
				repo: input.repo,
				runId: run.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		ingestedIds.push(run.id);
	}

	const newCursor = advanceCursor({ since, ingestedIds, inFlightIds });

	return {
		runs: mapGithubActionsToNormalizedRuns({
			workflowRuns: candidates,
			junitByRunId,
		}),
		newCursor: newCursor || null,
		truncated,
	};
}
