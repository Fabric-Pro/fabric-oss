/**
 * Backfill keyword vectors without replacing dense vectors or payloads.
 *
 * Qdrant's has_vector condition is supported since 1.13:
 * https://qdrant.tech/documentation/search/filtering/#has-vector
 * Schema creation requires 1.18 or newer:
 * https://qdrant.tech/documentation/manage-data/collections/#update-vector-schema
 *
 * Successful writes are the resume marker: reruns exclude them with has_vector.
 * The scroll cursor advances even for skipped points without content, so those
 * points are inspected at most once per invocation. They remain eligible on a
 * later run if their payload acquires content. Run with ingestion paused when a
 * stable snapshot is needed; scrolling is not a transactional snapshot.
 */
import { pathToFileURL } from "node:url";
import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { redactLogText } from "@repo/utils/log-redaction";
import { redactSensitiveKeys } from "@repo/utils/sensitive-keys";
import { generateSparseVector } from "../lib/embedding/sparse";

export const BACKFILL_USAGE = `Usage: pnpm --filter @repo/rag backfill:sparse -- [options]

Options:
  --dry-run             Count candidate and skipped points without writing
  --collection <name>   One project-contexts or project-contexts-org-* collection
  --batch-size <n>      Points per scroll/write batch, 1..1000 (default: 100)
  --help                Show this help

Without --collection, process all project-context collections.
Uses QDRANT_URL and QDRANT_API_KEY, as the app does.
Run after the server is on Qdrant >=1.18 and every worker runs this release.
Workers on the old release write dense-only vectors and strip sparse from the
points they re-embed, even after a restart. If backfill ran while any old-release
worker was running, rerun it.
The atomic missing-sparse write filter guards only against concurrent re-embeds
that already write sparse.
Rerun the backfill after any "Failed to enable sparse vectors" warning that
appeared while it ran.
Progress counts submitted candidates; the server may skip concurrent re-embeds.
Stops on the first error.
Rerun to resume: points already containing sparse are excluded. Points without
nonempty string content, or whose text has no keyword terms, are skipped using
the scroll cursor, with a count.
`;

interface BackfillOptions {
	collection?: string;
	dryRun: boolean;
	batchSize: number;
}
interface BackfillResult {
	collection: string;
	scanned: number;
	/** Candidate updates submitted; the server can skip concurrent re-embeds. */
	updated: number;
	skipped: number;
}
type BackfillClient = Pick<
	QdrantClient,
	"getCollections" | "getCollection" | "createVectorName" | "scroll"
> & {
	api: () => Pick<ReturnType<QdrantClient["api"]>, "updateVectors">;
};

function isProjectCollection(name: string): boolean {
	return (
		name === "project-contexts" ||
		(name.startsWith("project-contexts-org-") &&
			name.length > "project-contexts-org-".length)
	);
}
function validateBatchSize(size: number): void {
	if (!Number.isInteger(size) || size < 1 || size > 1000) {
		throw new Error(
			"Invalid batch size: expected an integer from 1 to 1000",
		);
	}
}
export function parseBackfillArgs(
	args: string[],
): BackfillOptions & { help: boolean } {
	const options: BackfillOptions & { help: boolean } = {
		dryRun: false,
		batchSize: 100,
		help: false,
	};
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--":
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--help":
				options.help = true;
				break;
			case "--batch-size":
				options.batchSize = Number(args[++i]);
				break;
			case "--collection": {
				const collection = args[++i];
				if (!collection || !isProjectCollection(collection)) {
					throw new Error(
						"Expected a project-context collection name",
					);
				}
				options.collection = collection;
				break;
			}
			default:
				throw new Error("Unknown backfill option; use --help");
		}
	}
	validateBatchSize(options.batchSize);
	return options;
}

export async function backfillSparseVectors(
	client: BackfillClient,
	options: BackfillOptions,
	progress: (message: string) => void = console.log,
): Promise<BackfillResult[]> {
	validateBatchSize(options.batchSize);
	if (options.collection && !isProjectCollection(options.collection)) {
		throw new Error("Expected a project-context collection name");
	}
	const names = options.collection
		? [options.collection]
		: (await client.getCollections()).collections
				.map((c) => c.name)
				.filter(isProjectCollection);
	const results: BackfillResult[] = [];
	for (const collection of names) {
		const info = await client.getCollection(collection);
		if (!options.dryRun && !info.config.params.sparse_vectors?.sparse) {
			await qdrantOperation("createVectorName", () =>
				client.createVectorName(collection, "sparse", { sparse: {} }),
			);
		}
		const result: BackfillResult = {
			collection,
			scanned: 0,
			updated: 0,
			skipped: 0,
		};
		let offset: string | number | undefined;
		do {
			const page = await client.scroll(collection, {
				limit: options.batchSize,
				offset,
				with_payload: ["content"],
				with_vector: false,
				filter: { must_not: [{ has_vector: "sparse" }] },
			});
			const points: Schemas["UpdateVectors"]["points"] = [];
			for (const point of page.points) {
				result.scanned++;
				const content = point.payload?.content;
				if (
					typeof content !== "string" ||
					content.trim().length === 0
				) {
					result.skipped++;
					continue;
				}
				const sparse = generateSparseVector(content);
				// Text with no keyword terms (only stopwords or symbols) yields an empty
				// sparse vector, which Qdrant rejects in updateVectors with 422 "must
				// specify vectors to update for point". Skip it like empty content.
				if (sparse.indices.length === 0) {
					result.skipped++;
					continue;
				}
				points.push({ id: point.id, vector: { sparse } });
			}
			if (!options.dryRun && points.length > 0) {
				// The 1.19 UpdateVectors schema supports update_filter, but the
				// SDK's convenience updateVectors method drops it. Use its typed API.
				const response = await qdrantOperation("updateVectors", () =>
					client.api().updateVectors({
						collection_name: collection,
						wait: true,
						points,
						update_filter: { must_not: [{ has_vector: "sparse" }] },
					}),
				);
				if (!response.data.result) {
					throw new Error("Qdrant returned no vector update result");
				}
			}
			result.updated += points.length;
			progress(
				`${options.dryRun ? "[dry-run] " : ""}${collection}: scanned=${result.scanned} ${options.dryRun ? "would-update" : "submitted"}=${result.updated} skipped=${result.skipped}`,
			);
			// next_page_offset is the next point ID, including zero; null ends the scan.
			const next = page.next_page_offset;
			if (
				next != null &&
				typeof next !== "string" &&
				typeof next !== "number"
			) {
				throw new Error("Qdrant returned an unsupported scroll cursor");
			}
			offset = next ?? undefined;
		} while (offset !== undefined);
		results.push(result);
	}
	return results;
}

type BackfillOperation = "createVectorName" | "updateVectors";
class BackfillOperationError extends Error {
	constructor(
		readonly operation: BackfillOperation,
		cause: unknown,
	) {
		super(
			cause instanceof Error ? cause.message : "Qdrant operation failed",
			{ cause },
		);
	}
}
async function qdrantOperation<T>(
	operation: BackfillOperation,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (cause) {
		throw new BackfillOperationError(operation, cause);
	}
}

function diagnosticText(text: string): string {
	const key = process.env.QDRANT_API_KEY;
	let safe = text;
	if (key) {
		safe = safe
			.replaceAll(key, "[REDACTED]")
			.replaceAll(encodeURIComponent(key), "[REDACTED]");
	}
	// Omit both parts of URL userinfo, including when a response echoes a URL.
	safe = safe.replace(
		/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi,
		"$1[REDACTED]@",
	);
	return redactLogText(safe).text;
}
function truncateDiagnostic(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)} [truncated]` : text;
}
function formatBackfillError(error: unknown): string {
	try {
		const operation =
			error instanceof BackfillOperationError
				? error.operation
				: undefined;
		const cause =
			error instanceof BackfillOperationError ? error.cause : error;
		const details =
			cause && typeof cause === "object"
				? (cause as Record<string, unknown>)
				: {};
		const status =
			typeof details.status === "number" ? details.status : undefined;
		const statusText =
			typeof details.statusText === "string"
				? diagnosticText(details.statusText)
				: "";
		// Only these response fields are emitted. Request headers and URL are excluded.
		const data = diagnosticText(
			JSON.stringify(redactSensitiveKeys(details.data), (key, value) => {
				if (["headers", "url"].includes(key.toLowerCase())) {
					return "[omitted]";
				}
				return typeof value === "string"
					? diagnosticText(value)
					: value;
			}) ?? "[no response data]",
		);
		let hint = "Check the configuration and rerun to resume.";
		if (status === 401 || status === 403) {
			hint = "Check QDRANT_API_KEY and its collection permissions.";
		} else if (operation === "createVectorName" && status === 404) {
			hint =
				"The sparse schema endpoint requires Qdrant >=1.18; check the server version.";
		} else if (
			operation === "updateVectors" &&
			/(?:not found|missing).*point|point.*(?:not found|does not exist|missing)|no point/i.test(
				data,
			)
		) {
			hint =
				"A live re-index may have deleted the point; rerun to resume.";
		}
		const message =
			status === undefined
				? truncateDiagnostic(
						diagnosticText(
							cause instanceof Error
								? cause.message
								: "Unknown Qdrant or configuration error",
						),
						200,
					)
				: `HTTP ${status} ${truncateDiagnostic(statusText, 200)}; data=${truncateDiagnostic(data, 1000)}`;
		return `Sparse backfill stopped${operation ? ` during ${operation}` : ""}: ${message}. ${hint}`;
	} catch {
		return "Sparse backfill stopped; error details could not be safely formatted. Check configuration and rerun to resume.";
	}
}

// Importing the runner does not construct a client or read credentials.
export async function runBackfillCli(
	args: string[],
	loadClient: () => Promise<BackfillClient> = async () =>
		(await import("../lib/vector-store/client")).qdrantClient,
	output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
	try {
		const options = parseBackfillArgs(args);
		if (options.help) {
			output.log(BACKFILL_USAGE);
		} else {
			await backfillSparseVectors(
				await loadClient(),
				options,
				(message) => output.log(message),
			);
		}
		return 0;
	} catch (error) {
		output.error(formatBackfillError(error));
		return 1;
	}
}

if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	void runBackfillCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
