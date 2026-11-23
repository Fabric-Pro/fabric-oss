import { isRecord } from "./parlume-stream-auth";

// What a Fabric job hands the realtime voice: its answer, and the only web
// addresses the voice may put in the meeting chat.

const MAX_RESULT_CHARS = 4_000;
const MAX_TURN_ID_CHARS = 128;
const MAX_KNOWN_ADDRESSES = 200;
// A web address that starts with its scheme or "www.", in any case.
const SCHEMED_ADDRESS = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
// Top-level domains that are not also common file extensions or words.
const WEB_DOMAINS = [
	"com",
	"org",
	"net",
	"edu",
	"gov",
	"io",
	"ai",
	"dev",
	"app",
	"co",
	"pro",
	"info",
	"biz",
	"cloud",
	"tech",
	"xyz",
	"site",
	"online",
	"page",
	"link",
	"gg",
	"ly",
	"tv",
	"uk",
	"us",
	"eu",
	"de",
	"fr",
	"nl",
	"ch",
	"se",
	"es",
	"ca",
	"au",
	"jp",
].join("|");
// A host without either ("example.com", "example.com:8080/app/F-12"), as
// Teams turns it into a link. Without a path its top-level domain is one of
// the above, in lower case, so "ASP.NET" is not taken for an address; nor is
// the domain of an email address. "example.co.uk" is one host, not
// "example.co" followed by text.
const BARE_ADDRESS = new RegExp(
	String.raw`(?<![\w@./-])(?:[A-Za-z0-9-]+\.)+(?:${WEB_DOMAINS})(?![\w-]|\.[A-Za-z0-9])(?::\d{1,5})?(?:[/?#][^\s<>"'()]*)?`,
	"g",
);
// Top-level domains kept for private networks, as a self-hosted deployment
// uses them ("fabric.internal/app").
const PRIVATE_DOMAINS = ["internal", "local", "lan", "corp"].join("|");
// With a path, a host on one of the domains above is an address in either
// case. Any other ending names code, such as "React.memo/useMemo",
// "lodash.get/set" or "Node.js/React"; one taken for a host refused the
// voice's whole post.
const PATH_ADDRESS = new RegExp(
	String.raw`(?<![\w@./-])(?:[a-z0-9-]+\.)+(?:${WEB_DOMAINS}|${PRIVATE_DOMAINS})(?::\d{1,5})?\/[^\s<>"'()]*`,
	"gi",
);

export interface ParlumeFabricResult {
	job: string;
	status: "completed" | "failed";
	text: string;
	/** Posts the worker already made with the full result. */
	chatTags: string[];
	/** The meeting turn that answered the job, for its spoken timing. */
	turnId?: string;
}

/** The worker's `fabric-result` body. */
export function parseParlumeFabricResult(
	body: unknown,
): ParlumeFabricResult | null {
	if (!isRecord(body) || typeof body.job !== "string") {
		return null;
	}
	const status = body.status;
	const text =
		typeof body.text === "string"
			? body.text.slice(0, MAX_RESULT_CHARS)
			: "";
	if (
		!/^J\d{1,6}$/.test(body.job) ||
		(status !== "completed" && status !== "failed") ||
		(status === "completed" && !text.trim())
	) {
		return null;
	}
	const chatTags = Array.isArray(body.chatTags)
		? body.chatTags
				.filter(
					(tag): tag is string =>
						typeof tag === "string" && /^P\d{1,6}$/.test(tag),
				)
				.slice(0, 10)
		: [];
	const turnId =
		typeof body.turnId === "string" &&
		body.turnId.length > 0 &&
		body.turnId.length <= MAX_TURN_ID_CHARS
			? body.turnId
			: null;
	return {
		job: body.job,
		status,
		text,
		chatTags,
		...(turnId ? { turnId } : {}),
	};
}

/**
 * The web addresses in a text, in the form they are compared in: lower case,
 * without the scheme, "www.", a trailing slash, or the punctuation that ends
 * a sentence. "HTTPS://Example.com/" and "example.com" are one address.
 */
function addressesIn(text: string): string[] {
	const matches = [
		...text.matchAll(SCHEMED_ADDRESS),
		...text.matchAll(BARE_ADDRESS),
		...text.matchAll(PATH_ADDRESS),
	].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return [
		...new Set(
			matches.map((match) =>
				match[0]
					.replace(/[.,;:!?]+$/, "")
					.toLowerCase()
					.replace(/^(?:https?:\/\/)?(?:www\.)?/, "")
					.replace(/\/+$/, ""),
			),
		),
	];
}

/**
 * The addresses the realtime voice may post: those a Fabric result gave, and
 * those already in the meeting chat. One the voice wrote itself may be
 * invented, or a link restated wrongly; Fabric looks links up in the
 * meeting's project, or says it could not find them.
 */
export class ParlumeVoiceAddresses {
	private readonly fromFabric: Set<string>;

	/** `known` is what `known()` returned before the bridge restarted. */
	constructor(known: string[] = []) {
		this.fromFabric = new Set(known.slice(-MAX_KNOWN_ADDRESSES));
	}

	noteResult(text: string): void {
		for (const address of addressesIn(text)) {
			this.fromFabric.delete(address);
			this.fromFabric.add(address);
		}
		for (const oldest of this.fromFabric) {
			if (this.fromFabric.size <= MAX_KNOWN_ADDRESSES) {
				break;
			}
			this.fromFabric.delete(oldest);
		}
	}

	/** The addresses Fabric gave, oldest first, for the saved context. */
	known(): string[] {
		return [...this.fromFabric];
	}

	/** The addresses in a post that neither Fabric nor the chat gave. */
	unverified(post: string, chat: Array<{ text: string }>): string[] {
		const known = new Set([
			...this.fromFabric,
			...chat.flatMap((message) => addressesIn(message.text)),
		]);
		return addressesIn(post).filter((address) => !known.has(address));
	}
}
