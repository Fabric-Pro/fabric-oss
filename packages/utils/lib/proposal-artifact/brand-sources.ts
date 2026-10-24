/**
 * Brand sources for a client-document Proposal (Fizzy #2946): where the
 * stored brand objects live, how a website fetch's attempt reads, and which
 * values a person may pick instead of the one that resolved.
 *
 * A value's source is the store it lives in. People write the document
 * Style, the Brand kit and the recipient brand; a website fetch writes only
 * its own row, with its last result kept apart from its current attempt, so
 * no fetch can replace or take away a value a person or an earlier fetch set.
 *
 * Pure functions and data only: the browser bundle imports this module.
 */

import { cutAtCodeUnits } from "../cut-at-code-units";
import type { ThemeTokenSource } from "./theme-tokens";

/** Every Brand kit object of one organization, in the `projectContexts` bucket. */
export function organizationBrandPrefix(organizationId: string): string {
	if (!organizationId) {
		// An empty id would turn the prefix into `organization-brand//`, which
		// every organization's objects share.
		throw new Error("An organization id is required for a brand key");
	}
	return `organization-brand/${organizationId}/`;
}

/** Where uploads wait until a Brand kit save promotes them. */
export function organizationBrandPendingPrefix(organizationId: string): string {
	return `${organizationBrandPrefix(organizationId)}pending/`;
}

/** Server-issued object ids: a UUID or a token, nothing that could be a path. */
const OBJECT_ID = /^[A-Za-z0-9_-]+$/;

export const ORGANIZATION_HERO_EXTENSIONS = ["png", "jpg"] as const;
export const ORGANIZATION_FONT_EXTENSIONS = ["woff2", "ttf"] as const;

export type OrganizationBrandAssetKind = "hero" | "fonts";

/**
 * The id inside a promoted Brand kit key of THIS organization, or null when
 * the key is anything else: `organization-brand/{organizationId}/{kind}/{id}.{ext}`
 * with an extension of that kind. A pending key, a nested path, another
 * organization's object or another kind's extension is null. The migration's
 * CHECK constraints accept exactly the same shapes.
 */
export function organizationBrandAssetId(
	organizationId: string,
	kind: OrganizationBrandAssetKind,
	key: string | null | undefined,
): string | null {
	if (!organizationId || typeof key !== "string") {
		return null;
	}
	const prefix = `${organizationBrandPrefix(organizationId)}${kind}/`;
	if (!key.startsWith(prefix)) {
		return null;
	}
	const rest = key.slice(prefix.length);
	const dot = rest.lastIndexOf(".");
	if (dot <= 0) {
		return null;
	}
	const id = rest.slice(0, dot);
	const extension = rest.slice(dot + 1);
	const extensions: readonly string[] =
		kind === "hero"
			? ORGANIZATION_HERO_EXTENSIONS
			: ORGANIZATION_FONT_EXTENSIONS;
	return OBJECT_ID.test(id) && extensions.includes(extension) ? id : null;
}

export function isOrganizationHeroKey(
	organizationId: string,
	key: string | null | undefined,
): key is string {
	return organizationBrandAssetId(organizationId, "hero", key) !== null;
}

export function isOrganizationFontKey(
	organizationId: string,
	key: string | null | undefined,
): key is string {
	return organizationBrandAssetId(organizationId, "fonts", key) !== null;
}

/** Where a project's recipient website fetch keeps the logo it found. */
export function recipientSuggestedLogoPrefix(projectId: string): string {
	if (!projectId) {
		throw new Error("A project id is required for a brand key");
	}
	return `project-brand/${projectId}/recipient-brand/suggested/`;
}

/**
 * Whether `key` is a suggested recipient logo of THIS project:
 * `project-brand/{projectId}/recipient-brand/suggested/{id}.png`.
 */
export function isRecipientSuggestedLogoKey(
	projectId: string,
	key: string | null | undefined,
): key is string {
	if (!projectId || typeof key !== "string") {
		return false;
	}
	const prefix = recipientSuggestedLogoPrefix(projectId);
	if (!key.startsWith(prefix) || !key.endsWith(".png")) {
		return false;
	}
	return OBJECT_ID.test(key.slice(prefix.length, -".png".length));
}

/** A host as the URL parser writes it: lowercase letters, digits, dots, hyphens. */
const BRAND_WEBSITE_HOST = /^[a-z0-9.-]+$/;

/**
 * Whether `hostname`, as the URL parser serialized it, is a name a brand
 * website may have: only lowercase letters, digits, dots and hyphens (an IDN
 * arrives as punycode), and not an IP address. The parser writes every IPv4
 * address in dotted decimal and every IPv6 address in brackets, so an
 * all-digit host is an address and a bracketed one fails the characters.
 */
export function isBrandWebsiteHost(hostname: string): boolean {
	return BRAND_WEBSITE_HOST.test(hostname) && !/^[0-9.]+$/.test(hostname);
}

/**
 * Whether `value` is a website in the one shape the brand rows store:
 * `https://host` with nothing after the host and a host
 * {@link isBrandWebsiteHost} accepts. The migration's CHECK constraints accept
 * the same characters.
 */
export function isBrandWebsite(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("https://")) {
		return false;
	}
	const host = value.slice("https://".length);
	if (!isBrandWebsiteHost(host)) {
		return false;
	}
	// The parser must write the host back unchanged (it would turn `0x7f.1`
	// into an address, say).
	try {
		return new URL(value).hostname === host;
	} catch {
		return false;
	}
}

/** The states a website fetch's attempt is stored in. */
export const BRAND_FETCH_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED"] as const;
export type BrandFetchStatus = (typeof BRAND_FETCH_STATUSES)[number];

/**
 * The fixed codes a failed attempt carries. They name what went wrong without
 * a host, a resolver message or anything the website sent.
 */
export const BRAND_FETCH_FAILURE_CODES = [
	"unreachable",
	"blocked",
	"too_large",
	"unsupported",
	"no_logo",
	"no_colors",
	"rate_limited",
	"not_member",
	"timed_out",
	"failed",
] as const;
export type BrandFetchFailureCode = (typeof BRAND_FETCH_FAILURE_CODES)[number];

/**
 * How long an attempt may stay RUNNING before it reads as timed out. A fetch
 * runs inside one request under a 15-second deadline; an attempt still
 * RUNNING well past that was cut off with its request and never finished.
 */
export const BRAND_FETCH_RUNNING_TTL_MS = 2 * 60 * 1000;

/** A second request within this window joins the attempt already running. */
export const BRAND_FETCH_JOIN_WINDOW_MS = 60 * 1000;

export interface BrandFetchAttempt {
	status: string;
	failureCode: string | null;
	requestedAt: Date;
}

/**
 * Whether a request for `website` at `now` joins `current` instead of
 * starting its own attempt: the same website's attempt, still RUNNING, that
 * started less than {@link BRAND_FETCH_JOIN_WINDOW_MS} before `now`. The
 * stored status is what a reader sees inside the window, which is shorter
 * than {@link BRAND_FETCH_RUNNING_TTL_MS}.
 */
export function isJoinableBrandFetchAttempt(
	current: { website: string; status: string; requestedAt: Date } | null,
	website: string,
	now: Date,
): boolean {
	return (
		current !== null &&
		current.status === "RUNNING" &&
		current.website === website &&
		now.getTime() - current.requestedAt.getTime() <
			BRAND_FETCH_JOIN_WINDOW_MS
	);
}

/**
 * The attempt as a reader should see it: a RUNNING attempt older than
 * {@link BRAND_FETCH_RUNNING_TTL_MS} is FAILED with `timed_out`, so a fetch
 * cut off with its request never shows as running forever.
 */
export function effectiveBrandFetchAttempt(
	attempt: BrandFetchAttempt,
	now: Date,
): { status: BrandFetchStatus; failureCode: BrandFetchFailureCode | null } {
	const status = (BRAND_FETCH_STATUSES as readonly string[]).includes(
		attempt.status,
	)
		? (attempt.status as BrandFetchStatus)
		: "FAILED";
	if (
		status === "RUNNING" &&
		now.getTime() - attempt.requestedAt.getTime() >
			BRAND_FETCH_RUNNING_TTL_MS
	) {
		return { status: "FAILED", failureCode: "timed_out" };
	}
	if (status !== "FAILED") {
		return { status, failureCode: null };
	}
	const code = (BRAND_FETCH_FAILURE_CODES as readonly string[]).includes(
		attempt.failureCode ?? "",
	)
		? (attempt.failureCode as BrandFetchFailureCode)
		: "failed";
	return { status, failureCode: code };
}

/** One value a source holds for a field, for the Style tab's alternatives. */
export interface BrandCandidate<T> {
	source: ThemeTokenSource;
	value: T;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function isGrounded(value: unknown): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return typeof value !== "string" || value.trim().length > 0;
}

/**
 * The values a person may pick instead of the resolved one: each source that
 * holds a grounded value differing from it, once per distinct value, in the
 * order given (precedence order). A source that agrees with the resolved
 * value, or holds nothing, offers nothing.
 */
export function brandAlternatives<T>(
	resolved: BrandCandidate<T>,
	candidates: readonly BrandCandidate<T>[],
): BrandCandidate<T>[] {
	const alternatives: BrandCandidate<T>[] = [];
	for (const candidate of candidates) {
		if (
			candidate.source === resolved.source ||
			!isGrounded(candidate.value) ||
			sameValue(candidate.value, resolved.value) ||
			alternatives.some((seen) => sameValue(seen.value, candidate.value))
		) {
			continue;
		}
		alternatives.push(candidate);
	}
	return alternatives;
}

/** Most UTF-16 code units a fetched or confirmed recipient name keeps. */
export const BRAND_NAME_MAX_LENGTH = 200;

/**
 * Controls (C0, C1), zero-width and bidi-formatting characters: none belongs
 * in a name, and each can break out of the slot the name is shown in.
 */
function isUnsafeNameCharacter(codePoint: number): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0xad ||
		codePoint === 0x61c ||
		codePoint === 0x180e ||
		(codePoint >= 0x200b && codePoint <= 0x200f) ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2060 && codePoint <= 0x2069) ||
		codePoint === 0xfeff
	);
}

/**
 * Tag characters and variation selectors: invisible, and able to carry text
 * nobody sees. They are removed, not spaced, since they sit inside a word.
 */
function isInvisibleModifier(codePoint: number): boolean {
	return (
		(codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef)
	);
}

/**
 * A name a website declared, made safe to show as text: unsafe characters
 * removed, whitespace collapsed, at most {@link BRAND_NAME_MAX_LENGTH} UTF-16
 * code units without splitting a character. Null when nothing is left. This
 * keeps the name inside its slot; it does not make it trustworthy, so it
 * stays a suggestion until a person confirms it, and it never becomes the
 * proposer's name.
 */
export function neutralizeBrandName(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const cleaned = Array.from(value, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (isInvisibleModifier(codePoint)) {
			return "";
		}
		return isUnsafeNameCharacter(codePoint) ? " " : character;
	})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) {
		return null;
	}
	return cutAtCodeUnits(cleaned, BRAND_NAME_MAX_LENGTH).trim();
}
