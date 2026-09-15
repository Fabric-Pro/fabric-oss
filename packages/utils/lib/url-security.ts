import {
	promises as dnsPromises,
	type LookupAddress,
	type LookupOptions,
	lookup,
} from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import {
	Agent,
	type Dispatcher,
	Dispatcher1Wrapper,
	fetch as undiciFetch,
} from "undici";

function getUnsafeIpv4ReasonFromOctets(octets: number[]): string | null {
	const [a, b] = octets;
	if (a === 0) {
		return "Unspecified network access (0.x.x.x) is not allowed";
	}
	if (a === 10) {
		return "Private network access (10.x.x.x) is not allowed";
	}
	if (a === 127) {
		return "Loopback address access is not allowed";
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return "Private network access (172.16-31.x.x) is not allowed";
	}
	if (a === 192 && b === 168) {
		return "Private network access (192.168.x.x) is not allowed";
	}
	if (a === 169 && b === 254) {
		return "Link-local address access is not allowed";
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return "Carrier-grade NAT network access is not allowed";
	}
	if (a === 192 && b === 0) {
		return "Reserved network access is not allowed";
	}
	if (a === 198 && (b === 18 || b === 19)) {
		return "Benchmark network access is not allowed";
	}
	if (a >= 224) {
		return "Multicast or reserved network access is not allowed";
	}
	return null;
}

function parseIpv4Octets(ipv4: string): number[] | null {
	const ipv4Match = ipv4.match(
		/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
	);
	if (!ipv4Match) {
		return null;
	}

	const octets = ipv4Match.slice(1).map((value) => Number(value));
	if (
		octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)
	) {
		return null;
	}

	return octets;
}

function expandIpv6ToHextets(address: string): number[] | null {
	let normalized = address.toLowerCase();
	const zoneIndex = normalized.indexOf("%");
	if (zoneIndex >= 0) {
		normalized = normalized.slice(0, zoneIndex);
	}

	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		if (lastColon === -1) {
			return null;
		}

		const ipv4Part = normalized.slice(lastColon + 1);
		const octets = parseIpv4Octets(ipv4Part);
		if (!octets) {
			return null;
		}

		const firstHextet = ((octets[0] << 8) | octets[1]).toString(16);
		const secondHextet = ((octets[2] << 8) | octets[3]).toString(16);
		normalized = `${normalized.slice(0, lastColon)}:${firstHextet}:${secondHextet}`;
	}

	const halves = normalized.split("::");
	if (halves.length > 2) {
		return null;
	}

	const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
	const right =
		halves.length === 2 && halves[1]
			? halves[1].split(":").filter(Boolean)
			: [];
	const missingGroups = 8 - (left.length + right.length);

	if ((halves.length === 1 && missingGroups !== 0) || missingGroups < 0) {
		return null;
	}

	const groups = [
		...left,
		...Array.from(
			{ length: halves.length === 2 ? missingGroups : 0 },
			() => "0",
		),
		...right,
	];

	if (groups.length !== 8) {
		return null;
	}

	const parsed = groups.map((group) => Number.parseInt(group, 16));
	if (
		parsed.some(
			(value) => Number.isNaN(value) || value < 0 || value > 0xffff,
		)
	) {
		return null;
	}

	return parsed;
}

function getEmbeddedIpv4ReasonFromIpv6(address: string): string | null {
	const groups = expandIpv6ToHextets(address);
	if (!groups) {
		return null;
	}

	const isMappedOrCompatible =
		groups.slice(0, 5).every((group) => group === 0) &&
		(groups[5] === 0xffff || groups[5] === 0);
	if (!isMappedOrCompatible) {
		return null;
	}

	const octets = [
		groups[6] >> 8,
		groups[6] & 0xff,
		groups[7] >> 8,
		groups[7] & 0xff,
	];
	return getUnsafeIpv4ReasonFromOctets(octets);
}

function getUnsafeIpAddressReason(address: string): string | null {
	const family = isIP(address);
	if (family === 4) {
		const octets = parseIpv4Octets(address);
		return octets
			? getUnsafeIpv4ReasonFromOctets(octets)
			: "Invalid IPv4 address";
	}
	if (family !== 6) {
		return "DNS returned an invalid IP address";
	}

	const normalized = address.toLowerCase();
	if (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	) {
		return "IPv6 link-local, loopback, or unspecified access is not allowed";
	}
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
		return "IPv6 unique local access is not allowed";
	}
	if (normalized.startsWith("ff")) {
		return "IPv6 multicast access is not allowed";
	}

	const embeddedReason = getEmbeddedIpv4ReasonFromIpv6(normalized);
	if (embeddedReason) {
		return embeddedReason;
	}
	const groups = expandIpv6ToHextets(normalized);
	if (!groups) {
		return "Invalid IPv6 address";
	}
	// Permit globally routable unicast only (2000::/3), then remove the
	// special-use blocks that live inside it. This fails closed for NAT64,
	// IPv4-translatable, site-local, benchmarking, and future reserved ranges.
	if ((groups[0] & 0xe000) !== 0x2000) {
		return "IPv6 special-use network access is not allowed";
	}
	if (
		(groups[0] === 0x2001 &&
			(groups[1] === 0 ||
				groups[1] === 2 ||
				groups[1] === 0x0db8 ||
				(groups[1] & 0xfff0) === 0x0010 ||
				(groups[1] & 0xfff0) === 0x0020)) ||
		groups[0] === 0x2002 ||
		(groups[0] === 0x3fff && (groups[1] & 0xf000) === 0)
	) {
		return "IPv6 reserved or transition network access is not allowed";
	}
	// Final word: anything not globally routable is refused (IPv4 special-use
	// denylist, IPv6 global-unicast allowlist) — see `isPrivateIp`.
	if (isPrivateIp(address)) {
		return "Address is not globally routable";
	}
	return null;
}

export function getUnsafeUrlReason(urlString: string): string | null {
	try {
		const url = new URL(urlString);
		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return `Protocol ${url.protocol} is not allowed`;
		}

		if (hostname === "localhost" || hostname === "0.0.0.0") {
			return "Localhost access is not allowed";
		}

		if (hostname.endsWith(".local") || hostname.endsWith(".localhost")) {
			return "Local domain access is not allowed";
		}

		if (
			hostname === "metadata" ||
			hostname === "metadata.google.internal" ||
			hostname === "169.254.169.254"
		) {
			return "Cloud metadata access is not allowed";
		}

		const normalizedIpv6 = hostname.replace(/^\[(.*)\]$/, "$1");
		if (isIP(normalizedIpv6)) {
			const unsafeIpReason = getUnsafeIpAddressReason(normalizedIpv6);
			if (unsafeIpReason) {
				return unsafeIpReason;
			}
		}

		return null;
	} catch {
		return "Invalid URL format";
	}
}

export function isPrivateOrLocalUrl(urlString: string): boolean {
	return getUnsafeUrlReason(urlString) !== null;
}

export function assertSafeOutboundUrl(urlString: string): void {
	const reason = getUnsafeUrlReason(urlString);
	if (reason) {
		throw new Error(reason);
	}
}

function blockedLookupError(
	hostname: string,
	reason: string,
): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(
		`Blocked outbound connection to ${hostname}: ${reason}`,
	);
	error.code = "EACCES";
	return error;
}

export type ResolveAllAddresses = (
	hostname: string,
	options: LookupOptions & { all: true; order: "verbatim" },
	callback: (
		error: NodeJS.ErrnoException | null,
		addresses: LookupAddress[],
	) => void,
) => void;

const resolveAllAddresses: ResolveAllAddresses = (
	hostname,
	options,
	callback,
) => {
	lookup(hostname, options, callback);
};

export function createSafeOutboundLookup(
	resolve: ResolveAllAddresses = resolveAllAddresses,
): LookupFunction {
	return (hostname, options, callback) => {
		resolve(
			hostname,
			{
				family: options.family,
				hints: options.hints,
				all: true,
				order: "verbatim",
			},
			(error, addresses: LookupAddress[]) => {
				if (error) {
					callback(error, "", 0);
					return;
				}
				if (addresses.length === 0) {
					callback(
						blockedLookupError(
							hostname,
							"DNS returned no addresses",
						),
						"",
						0,
					);
					return;
				}

				for (const address of addresses) {
					const unsafeReason = getUnsafeIpAddressReason(
						address.address,
					);
					if (unsafeReason) {
						callback(
							blockedLookupError(hostname, unsafeReason),
							"",
							0,
						);
						return;
					}
				}

				if (options.all) {
					callback(null, addresses);
					return;
				}
				const [address] = addresses;
				if (!address) {
					callback(
						blockedLookupError(
							hostname,
							"DNS returned no addresses",
						),
						"",
						0,
					);
					return;
				}
				callback(null, address.address, address.family);
			},
		);
	};
}

const safeOutboundLookup = createSafeOutboundLookup();

export async function assertSafeOutboundUrlResolved(
	urlString: string,
): Promise<void> {
	await resolveSafeOutboundAddresses(urlString);
}

export async function resolveSafeOutboundAddresses(
	urlString: string,
): Promise<string[]> {
	assertSafeOutboundUrl(urlString);
	const hostname = new URL(urlString).hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname)) {
		return [hostname];
	}

	return await new Promise<string[]>((resolve, reject) => {
		resolveAllAddresses(
			hostname,
			{ all: true, order: "verbatim" },
			(error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				if (addresses.length === 0) {
					reject(
						blockedLookupError(
							hostname,
							"DNS returned no addresses",
						),
					);
					return;
				}
				for (const address of addresses) {
					const reason = getUnsafeIpAddressReason(address.address);
					if (reason) {
						reject(blockedLookupError(hostname, reason));
						return;
					}
				}
				resolve(addresses.map((address) => address.address));
			},
		);
	});
}

const outboundDispatcher = new Dispatcher1Wrapper(
	new Agent({
		connect: {
			lookup: safeOutboundLookup,
		},
	}),
);

export async function safeFetchOutbound(
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = typeof input === "string" ? input : input.toString();
	assertSafeOutboundUrl(url);
	const requestInit: RequestInit = {
		...init,
		// Callers default to fail-closed redirects. `manual` is the sole
		// exception: it exposes the response to a caller that validates its
		// next browser hop. Automatic redirects stay closed because their next
		// destination cannot be checked here before a request leaves the process.
		redirect: init?.redirect === "manual" ? "manual" : "error",
	};
	Object.defineProperty(requestInit, "dispatcher", {
		value: outboundDispatcher,
		enumerable: true,
	});
	return fetch(url, requestInit);
}

// =============================================================================
// Pinned outbound fetch (plan Slice 4 prerequisite)
// =============================================================================
//
// `safeFetchOutbound` above validates the literal hostname only: a public
// DNS name that resolves to a private address (or that is rebound between
// validation and connect) still reaches the internal network. The pinned
// variant resolves every A/AAAA answer first, rejects the host if ANY answer
// is private / link-local / loopback / CGNAT / unspecified, and then connects
// to one pre-validated address through an undici Agent whose `lookup` returns
// that address. The request itself keeps the ORIGINAL hostname, so TLS SNI,
// certificate verification and the `Host` header are unchanged (never connect
// to a bare IP over HTTPS). Redirects are followed manually (max 3) and every
// hop is re-validated the same way.

/** IPv4 ranges that must never be reached from a server-side fetch. */
function isPrivateIpv4Octets(octets: readonly number[]): boolean {
	const [a, b, c] = octets;
	// Complete IANA special-use denylist (RFC 6890 / 5737 / 2544 / 7526 etc.),
	// not just RFC 1918: anything that is not globally routable is refused.
	return (
		a === 0 || // 0.0.0.0/8 "this network" (incl. unspecified)
		a === 10 || // 10/8
		a === 127 || // 127/8 loopback
		(a === 169 && b === 254) || // 169.254/16 link-local (cloud metadata)
		(a === 172 && b >= 16 && b <= 31) || // 172.16/12
		(a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
		(a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
		(a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 anycast (deprecated)
		(a === 192 && b === 168) || // 192.168/16
		(a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
		(a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
		(a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
		(a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
		a >= 224 // 224/4 multicast, 240/4 reserved, 255.255.255.255
	);
}

/**
 * True when `ip` (IPv4 or IPv6 literal) must not be reached from a
 * server-side fetch. IPv4 is a complete IANA special-use denylist. IPv6 is
 * an ALLOWLIST: only global unicast (2000::/3) minus its special-use
 * carve-outs is routable; everything else (unspecified, loopback,
 * IPv4-mapped/compatible, NAT64, discard, unique-local, link-local,
 * site-local, multicast, and any future/unassigned block) is refused, so a
 * newly assigned special range fails closed. IPv4-mapped forms are refused
 * outright rather than by their embedded address: a resolver should hand
 * back a plain A record, and pinning to a mapped literal would let the
 * embedded-address check drift from the real socket family.
 * Unparseable input is treated as private (fail closed).
 */
export function isPrivateIp(ip: string): boolean {
	const family = isIP(ip);
	if (family === 4) {
		const octets = parseIpv4Octets(ip);
		return octets ? isPrivateIpv4Octets(octets) : true;
	}
	if (family !== 6) {
		return true;
	}
	const groups = expandIpv6ToHextets(ip);
	if (!groups) {
		return true;
	}
	return !isGlobalUnicastIpv6(groups);
}

/**
 * Global unicast per IANA "IPv6 Special-Purpose Address Registry" and
 * "IPv6 Global Unicast Address Assignments": 2000::/3 except
 *   2001::/23      IETF protocol assignments (Teredo 2001::/32,
 *                  benchmarking 2001:2::/48, AMT 2001:3::/32, ORCHIDv2
 *                  2001:20::/28, ...)
 *   2001:db8::/32  documentation
 *   2002::/16      6to4 (deprecated; never dial it from a server)
 *   3fff::/20      documentation (RFC 9637)
 *   5f00::/16      SRv6 SIDs (RFC 9602)
 */
function isGlobalUnicastIpv6(groups: readonly number[]): boolean {
	const first = groups[0];
	if ((first & 0xe000) !== 0x2000) {
		return false; // outside 2000::/3
	}
	if (first === 0x2001 && (groups[1] & 0xfe00) === 0x0000) {
		return false; // 2001::/23
	}
	if (first === 0x2001 && groups[1] === 0x0db8) {
		return false; // 2001:db8::/32
	}
	if (first === 0x2002) {
		return false; // 2002::/16
	}
	if (first === 0x3fff && (groups[1] & 0xf000) === 0x0000) {
		return false; // 3fff::/20 (3fff:0000:: – 3fff:0fff:ffff::)
	}
	if (first === 0x5f00) {
		return false; // 5f00::/16
	}
	return true;
}

export interface PinnedFetchOptions {
	/** Maximum response body size in bytes (default 5 MB). */
	maxBytes?: number;
	/** Overall timeout for the request including redirects (default 10 s). */
	timeoutMs?: number;
	/**
	 * Allowed response media types (compared case-insensitively against the
	 * `content-type` header without parameters). A missing header is
	 * rejected. Default: JSON, YAML and plain text.
	 */
	allowedContentTypes?: string[];
	/** Maximum redirects to follow, each re-validated (default 3). */
	maxRedirects?: number;
	/**
	 * Test hook: a dispatcher used instead of the pinned Agent. DNS
	 * validation still runs. Never pass this from production code.
	 */
	dispatcher?: Dispatcher;
	/** Test hook: DNS resolver override (defaults to `dns.promises.lookup`). */
	lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface ResolvedAddress {
	address: string;
	family: number;
}

export const PINNED_FETCH_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const PINNED_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
export const PINNED_FETCH_DEFAULT_MAX_REDIRECTS = 3;
export const PINNED_FETCH_DEFAULT_CONTENT_TYPES = [
	"application/json",
	"application/yaml",
	"application/x-yaml",
	"text/yaml",
	"text/plain",
];

export class UnsafeOutboundUrlError extends Error {
	readonly code = "UNSAFE_OUTBOUND_URL" as const;
	constructor(message: string) {
		super(message);
		this.name = "UnsafeOutboundUrlError";
	}
}

export class OutboundResponseRejectedError extends Error {
	readonly code:
		| "RESPONSE_TOO_LARGE"
		| "CONTENT_TYPE_NOT_ALLOWED"
		| "TOO_MANY_REDIRECTS"
		| "REDIRECT_WITHOUT_LOCATION";
	constructor(code: OutboundResponseRejectedError["code"], message: string) {
		super(message);
		this.name = "OutboundResponseRejectedError";
		this.code = code;
	}
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
	const answers = await dnsPromises.lookup(hostname, { all: true });
	return answers.map((a) => ({ address: a.address, family: a.family }));
}

/**
 * Validate the literal URL, resolve the host and return one address that is
 * safe to connect to. Throws `UnsafeOutboundUrlError` if the literal check
 * fails, resolution fails, or ANY answer is private.
 */
export async function resolvePinnedAddress(
	urlString: string,
	lookup: (hostname: string) => Promise<ResolvedAddress[]> = defaultLookup,
): Promise<{ url: URL; address: ResolvedAddress }> {
	const reason = getUnsafeUrlReason(urlString);
	if (reason) {
		throw new UnsafeOutboundUrlError(reason);
	}
	const url = new URL(urlString);
	const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");

	// Literal IP: no DNS, but still subject to the range check.
	if (isIP(hostname)) {
		if (isPrivateIp(hostname)) {
			throw new UnsafeOutboundUrlError(
				`Address ${hostname} is not a public address`,
			);
		}
		return { url, address: { address: hostname, family: isIP(hostname) } };
	}

	let answers: ResolvedAddress[];
	try {
		answers = await lookup(hostname);
	} catch (error) {
		throw new UnsafeOutboundUrlError(
			`Could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (answers.length === 0) {
		throw new UnsafeOutboundUrlError(`${hostname} did not resolve`);
	}
	// Reject the host if ANY answer is private: a mixed public/private set is
	// the classic rebinding / split-horizon pattern.
	for (const answer of answers) {
		if (isPrivateIp(answer.address)) {
			throw new UnsafeOutboundUrlError(
				`${hostname} resolves to a non-public address`,
			);
		}
	}
	return { url, address: answers[0] };
}

function normalizeContentType(header: string | null): string | null {
	if (!header) {
		return null;
	}
	return header.split(";")[0].trim().toLowerCase();
}

function isRedirect(status: number): boolean {
	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
}

async function readBodyCapped(
	response: globalThis.Response | Awaited<ReturnType<typeof undiciFetch>>,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared && Number(declared) > maxBytes) {
		throw new OutboundResponseRejectedError(
			"RESPONSE_TOO_LARGE",
			`Response body exceeds ${maxBytes} bytes`,
		);
	}
	const body = response.body;
	if (!body) {
		return new Uint8Array(0);
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				total += value.byteLength;
				if (total > maxBytes) {
					throw new OutboundResponseRejectedError(
						"RESPONSE_TOO_LARGE",
						`Response body exceeds ${maxBytes} bytes`,
					);
				}
				chunks.push(value);
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Already closed.
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Fetch `input` with DNS-pinned SSRF protection (see the module comment).
 * The body is buffered (capped at `maxBytes`) and returned as a standard
 * `Response` so callers can use `.text()` / `.json()` as usual. Redirect
 * responses are followed manually — the returned response is never a
 * redirect.
 */
export async function safeFetchOutboundPinned(
	input: string | URL,
	init?: RequestInit,
	opts: PinnedFetchOptions = {},
): Promise<Response> {
	const maxBytes = opts.maxBytes ?? PINNED_FETCH_DEFAULT_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? PINNED_FETCH_DEFAULT_TIMEOUT_MS;
	const maxRedirects =
		opts.maxRedirects ?? PINNED_FETCH_DEFAULT_MAX_REDIRECTS;
	const allowed = (
		opts.allowedContentTypes ?? PINNED_FETCH_DEFAULT_CONTENT_TYPES
	).map((t) => t.toLowerCase());
	const lookup = opts.lookup ?? defaultLookup;

	const deadline = AbortSignal.timeout(timeoutMs);
	const signals: AbortSignal[] = [deadline];
	if (init?.signal) {
		signals.push(init.signal);
	}
	const signal = AbortSignal.any(signals);

	let currentUrl = typeof input === "string" ? input : input.toString();
	let method = init?.method ?? "GET";
	let body = init?.body ?? undefined;

	for (let hop = 0; hop <= maxRedirects; hop++) {
		const { url, address } = await resolvePinnedAddress(currentUrl, lookup);

		const ownAgent = opts.dispatcher
			? null
			: new Agent({
					connect: {
						// Pin the connection to the pre-validated address while
						// `servername` / `Host` stay on the original hostname.
						lookup: (
							_hostname: string,
							_options: unknown,
							callback: (
								err: Error | null,
								address: string,
								family: number,
							) => void,
						) => callback(null, address.address, address.family),
						timeout: timeoutMs,
					},
					headersTimeout: timeoutMs,
					bodyTimeout: timeoutMs,
				});
		const dispatcher = opts.dispatcher ?? (ownAgent as Dispatcher);

		let response: Awaited<ReturnType<typeof undiciFetch>>;
		try {
			response = await undiciFetch(url.toString(), {
				...(init as Parameters<typeof undiciFetch>[1]),
				method,
				body: body as never,
				signal,
				redirect: "manual",
				dispatcher,
			});

			if (isRedirect(response.status)) {
				const location = response.headers.get("location");
				// Drain so the connection can be reused/closed cleanly.
				await response.body?.cancel().catch(() => {});
				if (!location) {
					throw new OutboundResponseRejectedError(
						"REDIRECT_WITHOUT_LOCATION",
						`Redirect ${response.status} without a Location header`,
					);
				}
				if (hop === maxRedirects) {
					throw new OutboundResponseRejectedError(
						"TOO_MANY_REDIRECTS",
						`More than ${maxRedirects} redirects`,
					);
				}
				currentUrl = new URL(location, url).toString();
				// 303 (and 301/302 for POST) switch to GET without a body.
				if (
					response.status === 303 ||
					((response.status === 301 || response.status === 302) &&
						method.toUpperCase() === "POST")
				) {
					method = "GET";
					body = undefined;
				}
				continue;
			}

			const contentType = normalizeContentType(
				response.headers.get("content-type"),
			);
			if (!contentType || !allowed.includes(contentType)) {
				await response.body?.cancel().catch(() => {});
				throw new OutboundResponseRejectedError(
					"CONTENT_TYPE_NOT_ALLOWED",
					`Content type ${contentType ?? "(none)"} is not allowed`,
				);
			}

			const bytes = await readBodyCapped(response, maxBytes);
			const headers = new Headers();
			response.headers.forEach((value, key) => {
				headers.set(key, value);
			});
			const arrayBuffer = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer;
			return new Response(arrayBuffer, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		} finally {
			if (ownAgent) {
				await ownAgent.close().catch(() => {});
			}
		}
	}

	throw new OutboundResponseRejectedError(
		"TOO_MANY_REDIRECTS",
		`More than ${maxRedirects} redirects`,
	);
}
