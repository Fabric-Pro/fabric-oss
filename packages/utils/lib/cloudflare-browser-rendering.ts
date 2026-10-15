/**
 * Cloudflare Browser Rendering account endpoint.
 *
 * The `cloudflare` search-provider row stores its account ID in the generic
 * `endpoint` column as the account-scoped API base URL, the way the Cloudflare
 * AI Gateway provider carries its account in its base URL. The API token is
 * the row's encrypted key. The account ID is not a secret.
 *
 * The settings form, the API write guard and the scraper all read the column
 * through these helpers, so the one accepted shape is defined once: exactly
 * `https://api.cloudflare.com/client/v4/accounts/<32 lowercase hex>`.
 * Pure and dependency-free so the client bundle can import it.
 */

const CLOUDFLARE_ACCOUNTS_BASE =
	"https://api.cloudflare.com/client/v4/accounts";

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

const ACCOUNT_ENDPOINT_PATTERN =
	/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([0-9a-f]{32})$/;

/**
 * Whether `value` is a Cloudflare account ID: 32 lowercase hex characters.
 * Surrounding whitespace is not accepted; trim before asking.
 */
export function isCloudflareAccountId(value: string): boolean {
	return ACCOUNT_ID_PATTERN.test(value);
}

/**
 * The account-scoped base URL stored in the provider row's `endpoint`.
 * Throws on anything that is not an account ID, so a malformed value can never
 * be composed into a URL.
 */
export function cloudflareAccountEndpoint(accountId: string): string {
	if (!isCloudflareAccountId(accountId)) {
		throw new Error(
			"Cloudflare account ID must be 32 lowercase hexadecimal characters",
		);
	}
	return `${CLOUDFLARE_ACCOUNTS_BASE}/${accountId}`;
}

/**
 * The account ID in a stored endpoint, or `null` when the endpoint is missing
 * or is not exactly an account-scoped Cloudflare API base URL.
 */
export function parseCloudflareAccountId(
	endpoint: string | null | undefined,
): string | null {
	if (!endpoint) {
		return null;
	}
	const match = ACCOUNT_ENDPOINT_PATTERN.exec(endpoint);
	return match ? (match[1] ?? null) : null;
}

/**
 * The Browser Rendering `/markdown` URL for a stored endpoint, rebuilt from
 * the parsed account ID rather than appended to the stored string, or `null`
 * when the endpoint is not a valid account endpoint.
 */
export function cloudflareMarkdownUrl(
	endpoint: string | null | undefined,
): string | null {
	const accountId = parseCloudflareAccountId(endpoint);
	return accountId
		? `${cloudflareAccountEndpoint(accountId)}/browser-rendering/markdown`
		: null;
}

/** Shortest run of a token's leading characters treated as an echo of it. */
const MIN_REDACTED_PREFIX = 8;

/**
 * `text` with every echo of `token` replaced by `[redacted]`: each full
 * occurrence, and each run of at least eight of the token's leading
 * characters, which is what an upstream message that cut the token short
 * leaves behind. Callers redact the whole raw message before truncating it,
 * so a cut can never leave part of the token behind either.
 */
export function redactCloudflareToken(
	text: string,
	token: string | null | undefined,
): string {
	if (!token || text.length === 0) {
		return text;
	}
	let redacted = text.split(token).join("[redacted]");
	if (token.length <= MIN_REDACTED_PREFIX) {
		return redacted;
	}
	const head = token.slice(0, MIN_REDACTED_PREFIX);
	let from = 0;
	for (;;) {
		const start = redacted.indexOf(head, from);
		if (start === -1) {
			return redacted;
		}
		let end = start + head.length;
		while (
			end - start < token.length &&
			redacted[end] === token[end - start]
		) {
			end++;
		}
		redacted = `${redacted.slice(0, start)}[redacted]${redacted.slice(end)}`;
		from = start + "[redacted]".length;
	}
}
