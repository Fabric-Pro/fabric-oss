/**
 * `urlSourceCrawlWorkflow` with a URL whose file type cannot be indexed.
 *
 * The scrape, map and crawl activities now report such a URL as an
 * `unsupported` result instead of throwing. Each case runs the workflow
 * twice on a real (time-skipping) Temporal server: once with the activity
 * returning the outcome (current activities) and once with it throwing the
 * non-retryable `FIRECRAWL_UNSUPPORTED_CONTENT_TYPE` failure (histories
 * recorded before the change, or an older activity worker during a rollout).
 * Both runs must make the same activity calls with the same inputs, apart
 * from the `reportUnsupportedContent` request, end the same way, and both
 * histories must replay against the current workflow code.
 */
import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	PROJECT_EMBEDDING_TASK_QUEUE,
	PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
} from "../../src/task-queues";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let sequence = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping({
		server: process.env.TEMPORAL_TEST_SERVER_PATH
			? {
					executable: {
						type: "existing-path",
						path: process.env.TEMPORAL_TEST_SERVER_PATH,
					},
				}
			: undefined,
	});
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: resolve(__dirname, "../../src/workflows"),
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

const SVG_URL = "https://example.com/docs/logo.svg";
const SVG_MESSAGE =
	"The URL returned a file type that Firecrawl cannot process: image/svg+xml.";

type Variant = "outcome" | "failure";
type Call = [activity: string, input: Record<string, unknown>];

function isUnsupported(url: unknown): boolean {
	return typeof url === "string" && url.endsWith(".svg");
}

/** Activity doubles that record every call, in order. */
function makeActivities(variant: Variant, calls: Call[]) {
	const record =
		<R>(name: string, impl: (input: Record<string, unknown>) => R) =>
		async (input: Record<string, unknown>) => {
			const { reportUnsupportedContent: _ignored, ...rest } = input;
			calls.push([name, rest]);
			return impl(input);
		};

	const unsupportedOutcome = (input: Record<string, unknown>) => {
		if (variant === "failure" || input.reportUnsupportedContent !== true) {
			throw ApplicationFailure.nonRetryable(
				SVG_MESSAGE,
				"FIRECRAWL_UNSUPPORTED_CONTENT_TYPE",
				{ statusCode: 400 },
			);
		}
		return {
			contentType: "image/svg+xml",
			message: SVG_MESSAGE,
		};
	};

	return {
		firecrawlMapActivity: record("firecrawlMapActivity", (input) =>
			isUnsupported(input.url)
				? { urls: [], unsupported: unsupportedOutcome(input) }
				: {
						urls: [
							"https://example.com/docs/a",
							SVG_URL,
							"https://example.com/docs/c",
						],
					},
		),
		bulkInitUrlPagesActivity: record("bulkInitUrlPagesActivity", () => ({
			created: 3,
		})),
		firecrawlScrapeActivity: record("firecrawlScrapeActivity", (input) => {
			const url = String(input.url);
			if (isUnsupported(url)) {
				return {
					pageUrl: url,
					pageTitle: null,
					markdown: "",
					unsupported: unsupportedOutcome(input),
				};
			}
			return { pageUrl: url, pageTitle: "Page", markdown: `# ${url}` };
		}),
		upsertUrlPageActivity: record("upsertUrlPageActivity", (input) => ({
			pageId: `page:${String(input.pageUrl)}`,
			skipped: false,
		})),
		embedUrlPageActivity: record("embedUrlPageActivity", () => ({
			success: true,
		})),
		embedSingleContextActivity: record(
			"embedSingleContextActivity",
			() => ({
				success: true,
			}),
		),
		// A permanent failure of a URL with no fetched content is not kept,
		// as the real activity decides.
		recordUrlPageFetchFailureActivity: record(
			"recordUrlPageFetchFailureActivity",
			(input) => ({ kept: input.permanent !== true }),
		),
		recordUrlPageRetryFailureActivity: record(
			"recordUrlPageRetryFailureActivity",
			() => ({ recorded: true }),
		),
		pruneOrphanUrlPagesActivity: record(
			"pruneOrphanUrlPagesActivity",
			() => ({
				deleted: 0,
			}),
		),
		updateParentStatusActivity: record(
			"updateParentStatusActivity",
			() => ({
				success: true,
			}),
		),
	};
}

/** Strip the per-run wall-clock fields so two runs compare equal. */
function comparable(calls: Call[]): Call[] {
	return calls.map(([name, input]) => {
		const { urlLastSyncedAt: _a, urlNextRefreshAt: _b, ...rest } = input;
		return [name, rest];
	});
}

async function run(
	variant: Variant,
	input: Record<string, unknown>,
): Promise<{
	calls: Call[];
	result: PromiseSettledResult<unknown>;
	replayed: Promise<void>;
}> {
	const calls: Call[] = [];
	const activities = makeActivities(variant, calls);
	const taskQueue = `example-unsupported-${sequence++}`;
	const workflowId = `${taskQueue}-workflow`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const embeddings = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
		activities,
	});
	const operations = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities,
	});

	let result: PromiseSettledResult<unknown> = {
		status: "rejected",
		reason: new Error("not run"),
	};
	let history: Awaited<
		ReturnType<
			ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]
		>
	> | null = null;
	await operations.runUntil(
		embeddings.runUntil(
			workflowWorker.runUntil(async () => {
				const handle = await env.client.workflow.start(
					"urlSourceCrawlWorkflow",
					{ taskQueue, workflowId, args: [input] },
				);
				try {
					result = {
						status: "fulfilled",
						value: await handle.result(),
					};
				} catch (reason) {
					result = { status: "rejected", reason };
				}
				history = await handle.fetchHistory();
			}),
		),
	);
	if (!history) {
		throw new Error("no history recorded");
	}
	const recorded = history;
	return {
		calls,
		result,
		replayed: Worker.runReplayHistory(
			{ workflowBundle },
			recorded,
			workflowId,
		),
	};
}

const base = {
	contextId: "example-context",
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	apiKey: "example-key",
};

describe("urlSourceCrawlWorkflow with an unsupported content type", () => {
	it("completes the supported pages of a multi-URL crawl and skips the unsupported one", async () => {
		const input = {
			...base,
			url: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 3,
		};
		const current = await run("outcome", input);
		const legacy = await run("failure", input);

		expect(current.result).toEqual({
			status: "fulfilled",
			value: {
				success: true,
				scope: "PATH_PREFIX",
				pagesIndexed: 2,
				pagesSkipped: 0,
			},
		});
		const names = current.calls.map(([name]) => name);
		expect(
			current.calls
				.filter(([name]) => name === "upsertUrlPageActivity")
				.map(([, call]) => call.pageUrl),
		).toEqual(["https://example.com/docs/a", "https://example.com/docs/c"]);
		expect(
			current.calls.find(
				([name]) => name === "recordUrlPageFetchFailureActivity",
			)?.[1],
		).toMatchObject({
			pageUrl: SVG_URL,
			permanent: true,
			reason: SVG_MESSAGE,
		});
		expect(
			current.calls.find(
				([name]) => name === "pruneOrphanUrlPagesActivity",
			)?.[1],
		).toMatchObject({
			keptUrls: [
				"https://example.com/docs/a",
				"https://example.com/docs/c",
			],
		});
		expect(current.calls.at(-1)).toEqual([
			"updateParentStatusActivity",
			expect.objectContaining({
				extractionStatus: "COMPLETED",
				pagesIndexed: 2,
			}),
		]);
		expect(
			names.filter((name) => name === "firecrawlScrapeActivity"),
		).toHaveLength(3);

		// The same calls, in the same order, as the old failure path.
		expect(legacy.result).toEqual(current.result);
		expect(comparable(current.calls)).toEqual(comparable(legacy.calls));

		await expect(current.replayed).resolves.toBeUndefined();
		await expect(legacy.replayed).resolves.toBeUndefined();
	}, 120_000);

	it.each([
		{
			label: "a single-page source",
			input: { ...base, url: SVG_URL, scope: "SINGLE_PAGE", maxPages: 1 },
		},
		{
			label: "a path-prefix root the map cannot read",
			input: { ...base, url: SVG_URL, scope: "PATH_PREFIX", maxPages: 3 },
		},
	])(
		"ends $label FAILED with the same message as before",
		async ({ input }) => {
			const current = await run("outcome", input);
			const legacy = await run("failure", input);

			expect(current.calls.at(-1)).toEqual([
				"updateParentStatusActivity",
				expect.objectContaining({
					extractionStatus: "FAILED",
					extractionError: SVG_MESSAGE,
				}),
			]);
			expect(comparable(current.calls)).toEqual(comparable(legacy.calls));

			for (const { result } of [current, legacy]) {
				expect(result.status).toBe("rejected");
				const reason = (result as PromiseRejectedResult).reason as {
					cause?: { message?: string; type?: string };
				};
				expect(reason.cause).toMatchObject({
					message: SVG_MESSAGE,
					type: "URL_SOURCE_CRAWL_FAILED",
				});
			}

			await expect(current.replayed).resolves.toBeUndefined();
			await expect(legacy.replayed).resolves.toBeUndefined();
		},
		120_000,
	);

	it("finishes a retried unsupported page as FAILED, as before", async () => {
		const input = {
			...base,
			url: "https://example.com/docs",
			scope: "PATH_PREFIX",
			maxPages: 3,
			mode: "retry-single-page",
			retryPageUrl: SVG_URL,
		};
		const current = await run("outcome", input);
		const legacy = await run("failure", input);

		expect(current.calls.map(([name]) => name)).toEqual([
			"firecrawlScrapeActivity",
			"recordUrlPageRetryFailureActivity",
		]);
		expect(comparable(current.calls)).toEqual(comparable(legacy.calls));
		expect(current.result.status).toBe("rejected");
		expect(legacy.result.status).toBe("rejected");

		await expect(current.replayed).resolves.toBeUndefined();
		await expect(legacy.replayed).resolves.toBeUndefined();
	}, 120_000);
});
