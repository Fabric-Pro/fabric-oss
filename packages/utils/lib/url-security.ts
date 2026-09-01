import { type LookupAddress, type LookupOptions, lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, Dispatcher1Wrapper } from "undici";

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
