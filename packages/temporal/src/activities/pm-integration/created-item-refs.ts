import {
	COMMON_ID_FIELDS,
	COMMON_URL_FIELDS,
	extractWebUrlFromLinks,
	normalizeUrl,
} from "@repo/utils";

/**
 * Extract external ID and URL from MCP tool response.
 * Replicates the logic from story-sync.ts extractExternalInfo.
 *
 * The id a single-item story (or epic/feature) create stores: the push in
 * `syncWorkItemToPM`, which auto-push, retry and Unlink & re-create run.
 * Link to existing item reads a fetched item through the same function, so
 * a linked item carries the id that push would have stored for it.
 */
export function extractCreatedWorkItemRefs(
	output: unknown,
	options?: { baseUrl?: string | null; idParamHint?: string },
): { externalId?: string; externalUrl?: string } {
	if (!output) {
		return {};
	}

	let data = output as Record<string, unknown>;

	// Handle MCP response format with content array
	if (Array.isArray(data.content)) {
		const textContent = data.content.find(
			(c: unknown) =>
				typeof c === "object" &&
				c !== null &&
				(c as Record<string, unknown>).type === "text",
		) as { text?: string } | undefined;
		if (textContent?.text) {
			try {
				data = JSON.parse(textContent.text);
			} catch {
				/* Not JSON */
			}
		}
	}

	const { idParamHint } = options || {};
	let externalId = probeIdInObject(data, idParamHint);

	// Fallback: probe common wrapper objects (e.g. `{ card: { id: ... } }`,
	// `{ data: { id: ... } }`, `{ result: { ... } }`). Some PM-tool MCPs nest
	// the freshly-created record one level deep — without this, top-level
	// extraction silently misses on those responses, leaving the row
	// impossible to link back to the PM tool. The CREATE branch's atomicity
	// guard then stamps FAILED honestly rather than false SUCCESS, but
	// catching nested ids here avoids that path entirely for common shapes.
	if (externalId === undefined) {
		for (const wrapper of NESTED_RESPONSE_WRAPPERS) {
			const nested = data[wrapper];
			if (
				nested &&
				typeof nested === "object" &&
				!Array.isArray(nested)
			) {
				externalId = probeIdInObject(
					nested as Record<string, unknown>,
					idParamHint,
				);
				if (externalId !== undefined) {
					break;
				}
			}
		}
	}

	// Prefer HATEOAS web URL (`_links.html.href` / `_links.web.href`) over
	// the top-level `url` — Azure DevOps returns the REST-API endpoint there.
	let rawUrl = probeUrlInObject(data);
	if (rawUrl === undefined) {
		for (const wrapper of NESTED_RESPONSE_WRAPPERS) {
			const nested = data[wrapper];
			if (
				nested &&
				typeof nested === "object" &&
				!Array.isArray(nested)
			) {
				rawUrl = probeUrlInObject(nested as Record<string, unknown>);
				if (rawUrl !== undefined) {
					break;
				}
			}
		}
	}

	const externalUrl = normalizeUrl(rawUrl, options?.baseUrl);
	return { externalId, externalUrl };
}

/**
 * Wrapper keys some PM-tool MCPs nest a freshly-created record under.
 * Searched in order; first match wins. Kept narrow — broadening to generic
 * envelope names like `meta` or `payload` risks plucking the wrong id from a
 * mixed-response envelope.
 */
const NESTED_RESPONSE_WRAPPERS = [
	"card",
	"task",
	"item",
	"workItem",
	"work_item",
	"issue",
	"data",
	"result",
	"ticket",
] as const;

/**
 * The id in `obj`: the first readable value (`isReadableId`) among the hint
 * field and then `COMMON_ID_FIELDS`, in that order. A field holding anything
 * else (null, an object, an array, a boolean, NaN, an empty string) is
 * skipped and the next one is read, so a malformed field ahead of a valid
 * one does not hide it, and nothing is stringified into an id such as
 * "null" or "[object Object]".
 */
function probeIdInObject(
	obj: Record<string, unknown>,
	idParamHint: string | undefined,
): string | undefined {
	const fields = idParamHint
		? [idParamHint, ...COMMON_ID_FIELDS]
		: COMMON_ID_FIELDS;
	for (const field of fields) {
		const candidate = obj[field];
		if (isReadableId(candidate)) {
			return String(candidate);
		}
	}
	return undefined;
}

function probeUrlInObject(obj: Record<string, unknown>): string | undefined {
	const fromLinks = extractWebUrlFromLinks(obj);
	if (fromLinks) {
		return fromLinks;
	}
	for (const field of COMMON_URL_FIELDS) {
		if (obj[field] !== undefined) {
			return String(obj[field]);
		}
	}
	return undefined;
}

/**
 * A readable created id: a non-empty string or a finite number (0 included).
 * Anything else (null, an object, an array, a boolean, NaN) is not an id, and
 * is never stringified into one.
 */
export function isReadableId(candidate: unknown): candidate is string | number {
	return (
		(typeof candidate === "string" && candidate.trim() !== "") ||
		(typeof candidate === "number" && Number.isFinite(candidate))
	);
}

/**
 * The created item's id and URL, from the fields
 * `extractCreatedTestCaseRefs` reads, in its order (the display number a
 * tool keys its get and update on comes ahead of an internal id). The id is
 * the first of those fields that holds a non-empty string or a finite
 * number, 0 included; anything else (an object, which would stringify to
 * "[object Object]") is skipped. Empty strings when absent.
 *
 * Reads a parsed MCP response: the test-case create's
 * (`createTestCaseInPmWithClaim`), or an item fetched for Link to existing
 * item, so a linked case carries the id its create would have stored.
 */
export function readCreatedTestCaseRefs(parsed: unknown): {
	externalId: string;
	externalUrl: string;
} {
	const record = (
		parsed && typeof parsed === "object" ? parsed : {}
	) as Record<string, unknown>;
	const rawId = [
		record.card_number,
		record.number,
		record.iid,
		record.key,
		record.id,
		record.card_id,
		record.issue_id,
		record.task_id,
		record.work_item_id,
	].find(isReadableId);
	const externalId = rawId === undefined ? "" : String(rawId);
	const links = record._links as { web?: { href?: string } } | undefined;
	const externalUrl = String(
		links?.web?.href ||
			record.url ||
			record.link ||
			record.webUrl ||
			record.web_url ||
			"",
	);
	return { externalId, externalUrl };
}
