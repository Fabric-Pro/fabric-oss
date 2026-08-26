/**
 * Databricks Vector Search executor.
 *
 * Queries customer-managed Databricks Vector Search indexes (Delta Sync,
 * managed embeddings) with plain query_text. Credentials come decrypted from
 * the WorkflowIntegration credential fetcher — never from env.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { DatabricksTokenProvider } from "@repo/databricks";
// This file runs as ESM ("type": "module") but @repo/databricks transpiles to
// CJS, and Node's CJS lexer cannot see its named exports through tsx's output —
// static named imports fail to link when the temporal worker dynamically
// imports the executor registry. Prefer real named exports (bundled pipelines:
// Next.js, vitest, tsup) and fall back to unwrapping the CJS default (tsx).
import * as databricksModule from "@repo/databricks";
import { MAX_QUERY_INDEXES } from "./constants";

const databricksExports =
	typeof databricksModule.DatabricksApiClient === "function" &&
	typeof databricksModule.createOAuthM2MProvider === "function"
		? databricksModule
		: ((databricksModule as { default?: typeof databricksModule })
				.default ?? databricksModule);
const { createOAuthM2MProvider, DatabricksApiClient } = databricksExports;
type DatabricksApiClient = InstanceType<typeof DatabricksApiClient>;

export { MAX_QUERY_INDEXES } from "./constants";

export interface DatabricksVectorIndexInfo {
	name: string;
	schema: string;
	endpointName: string;
	indexType: string;
}

export interface DatabricksVectorSearchChunk {
	indexName: string;
	id: string;
	content: string;
	score: number;
}

export interface DatabricksVectorSearchResult {
	chunks: DatabricksVectorSearchChunk[];
	/** Per-index error strings for indexes that failed while others succeeded */
	failures: string[];
	/**
	 * Deduped index names beyond MAX_QUERY_INDEXES that were not queried at
	 * all. Empty when the caller supplied MAX_QUERY_INDEXES or fewer indexes.
	 */
	skippedIndexes: string[];
}

interface ExecOptions {
	fetchImpl?: typeof fetch;
}

const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 50;
const INDEX_DETAIL_CONCURRENCY = 5;
const QUERY_CONCURRENCY = 5;
// Defensive cap on pages fetched per endpoints/indexes collection — a
// misbehaving API returning an unending next_page_token must not hang forever.
const MAX_PAGINATION_PAGES = 20;
// Restrict tenant-supplied hosts to Databricks-controlled workspace domains;
// DNS/IP-only checks can still permit rebinding to private infrastructure.
const DATABRICKS_WORKSPACE_DOMAIN_SUFFIXES = [
	"azuredatabricks.net",
	"cloud.databricks.com",
	"gcp.databricks.com",
	"databricks.azure.cn",
	"databricks.azure.us",
	"cloud.databricks.us",
	"cloud.databricks.mil",
] as const;

// Reuse token providers per host+clientId so the M2M token cache is shared
// across calls within a worker process.
const providerCache = new Map<string, DatabricksTokenProvider>();

// Index query metadata (primary key + text column) per (host, indexName),
// with a TTL. The metadata GET was previously recomputed on EVERY query call
// — one extra REST round-trip per index per query — which multiplies badly
// on retrieval paths that issue several queries per invocation (the
// "Update using context" RRF branch). Columns of an index change rarely;
// 5 minutes of staleness is acceptable (a changed index surfaces a clear
// manifest-mismatch error and heals on the next TTL expiry).
//
// The cache stores the IN-FLIGHT promise, not just the resolved value, so N
// concurrent cold-cache callers (the RRF branch fires 3 sub-queries at once)
// coalesce onto ONE metadata GET instead of issuing N redundant ones.
// Rejections evict the entry so a failed fetch never poisons the cache.
const INDEX_META_TTL_MS = 5 * 60_000;
const indexMetaCache = new Map<
	string,
	{ promise: Promise<IndexQueryMeta>; expiresAt: number }
>();

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException("This operation was aborted", "AbortError")
	);
}

/**
 * Wait on `promise`, but stop waiting (reject) when `signal` fires. Used for
 * the SHARED index-metadata fetch: the caller's timeout must not cancel a
 * single-flight promise other callers are coalesced onto, so the fetch is
 * left running (it is a small GET) and only this caller's wait is aborted.
 */
function waitAbortable<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function __resetDatabricksVectorSearchCachesForTests(): void {
	providerCache.clear();
	indexMetaCache.clear();
}

function requireCredentials(credentials: Record<string, string>): {
	host: string;
	clientId: string;
	clientSecret: string;
} {
	const host = credentials.DATABRICKS_HOST;
	const clientId = credentials.DATABRICKS_CLIENT_ID;
	const clientSecret = credentials.DATABRICKS_CLIENT_SECRET;
	if (!host || !clientId || !clientSecret) {
		throw new Error(
			"Databricks credentials incomplete: host, client ID, and client secret are required",
		);
	}

	let parsedHost: URL;
	try {
		parsedHost = new URL(host.trim());
	} catch {
		throw new Error(
			"DATABRICKS_HOST must be an HTTPS Databricks workspace origin on a supported Databricks domain",
		);
	}

	const hostname = parsedHost.hostname.toLowerCase();
	const unbracketedHostname = hostname.replace(/^\[|\]$/g, "");
	const isWorkspaceDomain = DATABRICKS_WORKSPACE_DOMAIN_SUFFIXES.some(
		(suffix) => hostname.endsWith(`.${suffix}`),
	);
	const isObviouslyInternal =
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal");
	if (
		parsedHost.protocol !== "https:" ||
		parsedHost.username ||
		parsedHost.password ||
		parsedHost.pathname !== "/" ||
		parsedHost.search ||
		parsedHost.hash ||
		parsedHost.port ||
		isIP(unbracketedHostname) !== 0 ||
		isObviouslyInternal ||
		!isWorkspaceDomain
	) {
		throw new Error(
			"DATABRICKS_HOST must be an HTTPS Databricks workspace origin on a supported Databricks domain, without credentials, a path, query, fragment, IP address, or non-default port",
		);
	}

	return { host: parsedHost.origin, clientId, clientSecret };
}

function buildClient(
	credentials: Record<string, string>,
	options?: ExecOptions,
): DatabricksApiClient {
	const { host, clientId, clientSecret } = requireCredentials(credentials);
	const secretDigest = createHash("sha256")
		.update(clientSecret)
		.digest("hex")
		.slice(0, 16);
	const cacheKey = `${host}::${clientId}::${secretDigest}`;
	let tokenProvider = providerCache.get(cacheKey);
	if (!tokenProvider || options?.fetchImpl) {
		tokenProvider = createOAuthM2MProvider(
			host,
			clientId,
			clientSecret,
			options?.fetchImpl,
		);
		if (!options?.fetchImpl) {
			providerCache.set(cacheKey, tokenProvider);
		}
	}
	return new DatabricksApiClient({
		host,
		tokenProvider,
		fetchImpl: options?.fetchImpl,
	});
}

export async function verifyDatabricksVectorSearchConnection(
	credentials: Record<string, string>,
	options?: ExecOptions,
): Promise<{ success: boolean; message?: string; error?: string }> {
	try {
		const client = buildClient(credentials, options);
		const result = await client.request<{
			endpoints?: Array<{ name: string }>;
		}>("GET", "/api/2.0/vector-search/endpoints");
		const count = result?.endpoints?.length ?? 0;
		return {
			success: true,
			message: `Connected — ${count} vector search endpoint${count === 1 ? "" : "s"} visible`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to connect to Databricks Vector Search",
		};
	}
}

interface DatabricksEndpointsResponse {
	endpoints?: Array<{ name: string }>;
	next_page_token?: string;
}

interface DatabricksIndexesResponse {
	vector_indexes?: Array<{
		name: string;
		endpoint_name: string;
		index_type: string;
	}>;
	next_page_token?: string;
}

/**
 * Fetches every page of a Databricks vector-search list endpoint, following
 * `next_page_token` via a `page_token` query param until it is unset. Bails
 * out with a clear error rather than silently truncating if the collection
 * doesn't terminate within MAX_PAGINATION_PAGES.
 */
async function paginateDatabricksCollection<
	TPage extends { next_page_token?: string },
>(
	client: DatabricksApiClient,
	basePath: string,
	baseParams: Record<string, string>,
): Promise<TPage[]> {
	const pages: TPage[] = [];
	let pageToken: string | undefined;
	let pageCount = 0;
	do {
		pageCount++;
		if (pageCount > MAX_PAGINATION_PAGES) {
			throw new Error(
				`Databricks ${basePath} pagination did not terminate within ${MAX_PAGINATION_PAGES} pages`,
			);
		}
		const params = new URLSearchParams(baseParams);
		if (pageToken) {
			params.set("page_token", pageToken);
		}
		const query = params.toString();
		const page = await client.request<TPage>(
			"GET",
			query ? `${basePath}?${query}` : basePath,
		);
		pages.push(page);
		pageToken = page?.next_page_token;
	} while (pageToken);
	return pages;
}

export async function listDatabricksVectorIndexes(
	credentials: Record<string, string>,
	options?: ExecOptions,
): Promise<DatabricksVectorIndexInfo[]> {
	const client = buildClient(credentials, options);
	const endpointPages =
		await paginateDatabricksCollection<DatabricksEndpointsResponse>(
			client,
			"/api/2.0/vector-search/endpoints",
			{},
		);
	const endpoints = endpointPages.flatMap((page) => page.endpoints ?? []);

	const candidates: DatabricksVectorIndexInfo[] = [];
	for (const endpoint of endpoints) {
		const indexPages =
			await paginateDatabricksCollection<DatabricksIndexesResponse>(
				client,
				"/api/2.0/vector-search/indexes",
				{ endpoint_name: endpoint.name },
			);
		const indexes = indexPages.flatMap((page) => page.vector_indexes ?? []);
		for (const index of indexes) {
			if (index.index_type !== "DELTA_SYNC") {
				continue;
			}
			// name is catalog.schema.index — schema is the first two parts
			const parts = index.name.split(".");
			if (parts.length !== 3) {
				continue;
			}
			candidates.push({
				name: index.name,
				schema: `${parts[0]}.${parts[1]}`,
				endpointName: index.endpoint_name,
				indexType: index.index_type,
			});
		}
	}

	const eligibility = await mapWithConcurrency(
		candidates,
		INDEX_DETAIL_CONCURRENCY,
		async (index) => {
			// The list response identifies Delta Sync indexes but omits whether
			// their embeddings are managed, so details are required for parity
			// with the runtime query contract.
			const detail = await getIndexDetail(client, index.name);
			return getIndexQueryMetaFromDetail(detail) &&
				detail.status?.ready !== false
				? index
				: null;
		},
	);
	return eligibility.filter(
		(index): index is DatabricksVectorIndexInfo => index !== null,
	);
}

interface IndexQueryMeta {
	primaryKey: string;
	textColumn: string;
}

interface DatabricksVectorIndexDetail {
	primary_key?: string;
	status?: { ready?: boolean };
	delta_sync_index_spec?: {
		embedding_source_columns?: Array<{ name: string }>;
	};
	direct_access_index_spec?: unknown;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await mapper(items[index] as T);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

async function getIndexDetail(
	client: DatabricksApiClient,
	indexName: string,
): Promise<DatabricksVectorIndexDetail> {
	return client.request<DatabricksVectorIndexDetail>(
		"GET",
		`/api/2.0/vector-search/indexes/${encodeURIComponent(indexName)}`,
	);
}

function getIndexQueryMetaFromDetail(
	detail: DatabricksVectorIndexDetail,
): IndexQueryMeta | null {
	const textColumn =
		detail?.delta_sync_index_spec?.embedding_source_columns?.[0]?.name;
	if (!detail?.primary_key || !textColumn) {
		return null;
	}
	return { primaryKey: detail.primary_key, textColumn };
}

function getIndexQueryMeta(
	client: DatabricksApiClient,
	host: string,
	indexName: string,
): Promise<IndexQueryMeta> {
	const cacheKey = `${host}::${indexName}`;
	const cached = indexMetaCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.promise;
	}
	const promise = (async () => {
		const detail = await getIndexDetail(client, indexName);
		const meta = getIndexQueryMetaFromDetail(detail);
		if (!meta) {
			throw new Error(
				`Index ${indexName} does not expose a text column with managed embeddings; only Delta Sync indexes with embedding_source_columns are supported`,
			);
		}
		if (detail.status?.ready === false) {
			throw new Error(`Index ${indexName} is not ready`);
		}
		return meta;
	})();
	indexMetaCache.set(cacheKey, {
		promise,
		expiresAt: Date.now() + INDEX_META_TTL_MS,
	});
	// Evict on rejection so a failed fetch doesn't poison the cache for its
	// TTL. Guarded on identity so a newer entry is never deleted by an older
	// failure.
	promise.catch(() => {
		if (indexMetaCache.get(cacheKey)?.promise === promise) {
			indexMetaCache.delete(cacheKey);
		}
	});
	return promise;
}

function normalizeNumResults(numResults: number | undefined): number {
	if (typeof numResults !== "number" || !Number.isFinite(numResults)) {
		return DEFAULT_NUM_RESULTS;
	}
	return Math.min(MAX_NUM_RESULTS, Math.max(1, Math.floor(numResults)));
}

export async function queryDatabricksVectorIndexes(
	credentials: Record<string, string>,
	args: {
		indexNames: string[];
		query: string;
		numResults?: number;
		fetchImpl?: typeof fetch;
		/**
		 * Aborts the per-index search requests (and this caller's wait on the
		 * shared metadata fetch). Callers with a wall-clock budget must pass
		 * this so a slow workspace doesn't accumulate orphaned in-flight
		 * requests after they stop waiting.
		 */
		signal?: AbortSignal;
	},
): Promise<DatabricksVectorSearchResult> {
	const { indexNames, query, signal } = args;
	if (!query?.trim()) {
		throw new Error("query is required");
	}
	if (!indexNames?.length) {
		throw new Error("At least one index must be selected");
	}
	const client = buildClient(credentials, { fetchImpl: args.fetchImpl });
	const { host } = requireCredentials(credentials);
	const numResults = normalizeNumResults(args.numResults);

	const dedupedIndexNames = Array.from(new Set(indexNames));
	const queriedIndexNames = dedupedIndexNames.slice(0, MAX_QUERY_INDEXES);
	const skippedIndexes = dedupedIndexNames.slice(MAX_QUERY_INDEXES);

	const chunks: DatabricksVectorSearchChunk[] = [];
	const queryFailures: string[] = [];
	let successCount = 0;
	await mapWithConcurrency(
		queriedIndexNames,
		QUERY_CONCURRENCY,
		async (indexName) => {
			try {
				const meta = await waitAbortable(
					getIndexQueryMeta(client, host, indexName),
					signal,
				);
				const result = await client.request<{
					manifest?: { columns?: Array<{ name: string }> };
					result?: { data_array?: unknown[][] };
				}>(
					"POST",
					`/api/2.0/vector-search/indexes/${encodeURIComponent(indexName)}/query`,
					{
						query_text: query,
						query_type: "HYBRID",
						num_results: numResults,
						columns: [meta.primaryKey, meta.textColumn],
					},
					{ signal },
				);
				const columns = (result?.manifest?.columns ?? []).map(
					(c) => c.name,
				);
				const idPos = columns.indexOf(meta.primaryKey);
				const textPos = columns.indexOf(meta.textColumn);
				if (idPos === -1 || textPos === -1) {
					throw new Error(
						`query response manifest is missing expected columns ${meta.primaryKey}/${meta.textColumn} (got: ${columns.join(", ") || "none"})`,
					);
				}
				for (const row of result?.result?.data_array ?? []) {
					chunks.push({
						indexName,
						id: String(row[idPos] ?? ""),
						content: String(row[textPos] ?? ""),
						// similarity score is always the last column
						score: Number(row[row.length - 1] ?? 0),
					});
				}
				successCount++;
			} catch (error) {
				queryFailures.push(
					`${indexName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	);

	if (successCount === 0 && queryFailures.length > 0) {
		throw new Error(
			`Databricks vector search failed for all indexes — ${queryFailures.join("; ")}`,
		);
	}

	chunks.sort((a, b) => b.score - a.score);
	return {
		chunks: chunks.slice(0, numResults),
		failures: queryFailures,
		skippedIndexes,
	};
}
