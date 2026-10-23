/**
 * The website brand fetch attempt (Fizzy #2946): one procedure call runs one
 * bounded fetch of a website someone stored, and records how it went in the
 * fetch's own row. Two subjects share it: the organization's own website
 * (the Brand kit's `website`, read into `OrganizationBrandSiteFetch`) and a
 * project's recipient website (the recipient brand's `website`, read into
 * the project's recipient suggestion).
 *
 * In order:
 *  1. the website is the stored one; no caller ever names it, and one stored
 *     before the host rule existed that fails it is refused as BAD_REQUEST;
 *  2. a second call while the same website's attempt has been RUNNING for
 *     under a minute returns that attempt and fetches nothing;
 *  3. the per-user website lookup limit and a per-organization limit per
 *     subject, before any outbound request. A refused automatic call is
 *     recorded as FAILED `rate_limited`; a refused explicit one answers
 *     TOO_MANY_REQUESTS (SERVICE_UNAVAILABLE when the limiter is down);
 *  4. the attempt is recorded as RUNNING, only while the stored website is
 *     still the one being fetched;
 *  5. the fetch runs under the request's signal and one 15-second deadline,
 *     and is audited with its host and a fixed code;
 *  6. the finish writes only while this attempt is still the current one.
 *     Any error or abort finishes it as FAILED with a fixed code.
 *
 * Nothing here calls a model, and no fetched text reaches a prompt or a log.
 * People-owned rows (the Brand kit, the recipient brand) are read, never
 * written.
 */
import { createHash, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	type FinishRecipientBrandSuggestionResult,
	finishBrandSiteFetch,
	finishRecipientBrandSuggestion,
	getBrandKit,
	getBrandSiteFetch,
	getRecipientBrand,
	getRecipientBrandSuggestion,
	startBrandSiteFetch,
	startRecipientBrandSuggestion,
} from "@repo/database";
import {
	fetchVendorBrand,
	fetchWebsiteBrand,
	WEBSITE_BRAND_RATE_LIMIT,
	websiteBrandRateLimitKey,
} from "@repo/integrations/website-brand";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import {
	BRAND_FETCH_FAILURE_CODES,
	BRAND_FETCH_STATUSES,
	type BrandFetchFailureCode,
	effectiveBrandFetchAttempt,
	isBrandWebsite,
	isJoinableBrandFetchAttempt,
	recipientSuggestedLogoPrefix,
} from "@repo/utils/proposal-artifact/brand-sources";
import { z } from "zod";
import {
	deleteRecipientBrandObjects,
	recipientBrandBucket,
} from "../modules/projects/lib/recipient-brand";
import { type AuditRequestContext, recordAuditFromRequest } from "./audit";
import { checkRateLimit } from "./rate-limit";

/** One deadline for the whole fetch, tied to the request that runs it. */
const BRAND_FETCH_DEADLINE_MS = 15_000;

/** Fetches per organization per subject, every member's calls combined. */
export const BRAND_FETCH_ORGANIZATION_RATE_LIMIT = {
	limit: 20,
	windowMs: 60 * 60_000,
} as const;

type BrandFetchSubject = "site" | "recipient";

function brandFetchOrganizationRateLimitKey(
	organizationId: string,
	subject: BrandFetchSubject,
): string {
	return `website-brand:org:${organizationId}:${subject}`;
}

/** The attempt as a reader sees it: a stale RUNNING one reads as timed out. */
export const brandFetchAttemptSchema = z.object({
	status: z.enum(BRAND_FETCH_STATUSES),
	failureCode: z.enum(BRAND_FETCH_FAILURE_CODES).nullable(),
	website: z.string(),
	requestedAt: z.date(),
});

export type BrandFetchAttemptView = z.infer<typeof brandFetchAttemptSchema>;

interface StoredAttempt {
	website: string;
	status: string;
	failureCode: string | null;
	requestedAt: Date;
}

type FetchOutcome<Value> =
	| { ok: true; value: Value; auditCode: string }
	| { ok: false; code: BrandFetchFailureCode };

interface BrandFetchAttemptSpec<Value> {
	subject: BrandFetchSubject;
	/** The subject's id, for logs. */
	subjectId: string;
	organizationId: string;
	userId: string;
	automatic: boolean;
	signal?: AbortSignal;
	/** The stored website, `https://host`. */
	website: string;
	readAttempt: () => Promise<StoredAttempt | null>;
	startAttempt: (attempt: {
		requestId: string;
		requestedAt: Date;
		failureCode?: BrandFetchFailureCode;
	}) => Promise<"started" | "stale" | "joined">;
	fetch: (signal: AbortSignal) => Promise<FetchOutcome<Value>>;
	audit: (code: string, succeeded: boolean) => void;
	/** Store what the fetch found and finish; false when superseded. */
	finishSuccess: (requestId: string, value: Value) => Promise<boolean>;
	/** Finish as FAILED; false when superseded. */
	finishFailure: (
		requestId: string,
		code: BrandFetchFailureCode,
	) => Promise<boolean>;
}

function toAttemptView(
	stored: StoredAttempt,
	now: Date = new Date(),
): BrandFetchAttemptView {
	const effective = effectiveBrandFetchAttempt(stored, now);
	return {
		status: effective.status,
		failureCode: effective.failureCode,
		website: stored.website,
		requestedAt: stored.requestedAt,
	};
}

async function readAttemptView(
	readAttempt: () => Promise<StoredAttempt | null>,
): Promise<BrandFetchAttemptView | null> {
	const stored = await readAttempt();
	return stored ? toAttemptView(stored) : null;
}

/** Reject with the signal's reason if it aborts before `promise` settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
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

/** The per-user lookup limit, then the organization's limit for the subject. */
async function checkBrandFetchLimits(
	userId: string,
	organizationId: string,
	subject: BrandFetchSubject,
) {
	const perUser = await checkRateLimit(
		websiteBrandRateLimitKey(userId),
		WEBSITE_BRAND_RATE_LIMIT.limit,
		WEBSITE_BRAND_RATE_LIMIT.windowMs,
	);
	if (!perUser.allowed) {
		return perUser;
	}
	return checkRateLimit(
		brandFetchOrganizationRateLimitKey(organizationId, subject),
		BRAND_FETCH_ORGANIZATION_RATE_LIMIT.limit,
		BRAND_FETCH_ORGANIZATION_RATE_LIMIT.windowMs,
	);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

/**
 * The stored website, refused when it is not one a fetch may read: a row
 * saved before the host rule existed may hold a host the rule now refuses.
 * The message names no host.
 */
function fetchableWebsite(website: string): string {
	if (!isBrandWebsite(website)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The saved website can't be fetched. Save it again first",
		});
	}
	return website;
}

async function runBrandFetchAttempt<Value>(
	spec: BrandFetchAttemptSpec<Value>,
): Promise<BrandFetchAttemptView | null> {
	const now = new Date();
	const current = await spec.readAttempt();
	if (current && isJoinableBrandFetchAttempt(current, spec.website, now)) {
		return toAttemptView(current, now);
	}

	const limit = await checkBrandFetchLimits(
		spec.userId,
		spec.organizationId,
		spec.subject,
	);
	const requestId = randomUUID();
	const requestedAt = new Date();
	if (!limit.allowed) {
		if (!spec.automatic) {
			if (limit.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many website lookups. Please try again in ${limit.resetInSeconds} seconds.`,
				data: { retryAfter: limit.resetInSeconds },
			});
		}
		// An automatic call nobody clicked: record why nothing was fetched, so
		// the form can say so, instead of failing a request no one is watching.
		const started = await spec.startAttempt({
			requestId,
			requestedAt,
			failureCode: "rate_limited",
		});
		return started === "started"
			? {
					status: "FAILED",
					failureCode: "rate_limited",
					website: spec.website,
					requestedAt,
				}
			: readAttemptView(spec.readAttempt);
	}

	if ((await spec.startAttempt({ requestId, requestedAt })) !== "started") {
		// The stored website changed since it was read, or a request for the
		// same website started just before this one; either way the attempt
		// already recorded is the one to show.
		return readAttemptView(spec.readAttempt);
	}

	const signals = [AbortSignal.timeout(BRAND_FETCH_DEADLINE_MS)];
	if (spec.signal) {
		signals.push(spec.signal);
	}
	const deadline = AbortSignal.any(signals);

	let outcome: FetchOutcome<Value>;
	try {
		const fetched = await untilAborted(spec.fetch(deadline), deadline);
		// The extractors answer an abort with a code of their own; the
		// attempt records it as the deadline it was.
		outcome = deadline.aborted ? { ok: false, code: "timed_out" } : fetched;
	} catch {
		outcome = {
			ok: false,
			code: deadline.aborted ? "timed_out" : "failed",
		};
	}
	// One row per outbound attempt, host and fixed code only, recorded before
	// anything is stored so a storage failure cannot lose it.
	spec.audit(outcome.ok ? outcome.auditCode : outcome.code, outcome.ok);

	let applied: boolean | null = null;
	let failureCode: BrandFetchFailureCode | null = outcome.ok
		? null
		: outcome.code;
	if (outcome.ok) {
		try {
			applied = await spec.finishSuccess(requestId, outcome.value);
		} catch (error) {
			logger.warn(
				`[BrandFetch] ${spec.subject} ${spec.subjectId} attempt ${requestId} could not be stored (${errorName(error)})`,
			);
			failureCode = "failed";
		}
	}
	if (failureCode) {
		try {
			applied = await spec.finishFailure(requestId, failureCode);
		} catch (error) {
			logger.warn(
				`[BrandFetch] ${spec.subject} ${spec.subjectId} attempt ${requestId} could not be finished (${errorName(error)})`,
			);
		}
	}

	if (applied === null) {
		// The row still says RUNNING; it reads as timed out once it is stale.
		return {
			status: "RUNNING",
			failureCode: null,
			website: spec.website,
			requestedAt,
		};
	}
	if (!applied) {
		// A newer attempt replaced this one; show that one.
		return readAttemptView(spec.readAttempt);
	}
	return {
		status: failureCode ? "FAILED" : "SUCCEEDED",
		failureCode,
		website: spec.website,
		requestedAt,
	};
}

/**
 * Fetch the organization's own website (the Brand kit's `website`) for the
 * colours it declares, into the organization's site fetch row. The caller
 * has authorized an admin or owner of `organizationId` and the rollout gate.
 */
export async function runBrandSiteFetch(args: {
	organizationId: string;
	userId: string;
	automatic: boolean;
	signal?: AbortSignal;
	context: AuditRequestContext;
}): Promise<BrandFetchAttemptView | null> {
	const { organizationId, userId, context } = args;
	const kit = await getBrandKit(organizationId);
	const stored = kit?.website ?? null;
	if (!stored) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Add the organization's website to the Brand kit first",
		});
	}
	const website = fetchableWebsite(stored);
	const host = new URL(website).hostname;

	return runBrandFetchAttempt<{
		primaryColor: string;
		accentColors: string[];
	}>({
		subject: "site",
		subjectId: organizationId,
		organizationId,
		userId,
		automatic: args.automatic,
		signal: args.signal,
		website,
		readAttempt: () => getBrandSiteFetch(organizationId),
		startAttempt: (attempt) =>
			startBrandSiteFetch({
				organizationId,
				website,
				requestedById: userId,
				...attempt,
			}),
		fetch: async (signal) => {
			const result = await fetchVendorBrand(website, { signal });
			// A success is audited with the tier its colours came from.
			return result.ok
				? {
						ok: true,
						auditCode: result.source,
						value: {
							primaryColor: result.primaryColor,
							accentColors: result.accentColors,
						},
					}
				: { ok: false, code: result.code };
		},
		audit: (code, succeeded) =>
			recordAuditFromRequest(context, {
				action: "org.brand_kit.site_fetched",
				category: "org",
				outcome: succeeded ? "success" : "failure",
				organizationId,
				resource: {
					type: "organization",
					id: organizationId,
					name: null,
				},
				metadata: { host, code },
			}),
		finishSuccess: (requestId, value) =>
			finishBrandSiteFetch({
				organizationId,
				requestId,
				website,
				outcome: { ok: true, ...value },
				fetchedAt: new Date(),
			}),
		finishFailure: (requestId, failureCode) =>
			finishBrandSiteFetch({
				organizationId,
				requestId,
				website,
				outcome: { ok: false, failureCode },
				fetchedAt: new Date(),
			}),
	});
}

/**
 * Fetch a project's recipient website (the recipient brand's `website`) into
 * the project's recipient suggestion: a logo, colours and the name the site
 * declares, shown as fetched and not applied until a member confirms a field.
 * The caller has passed the recipient brand's write gate for `projectId`,
 * whose owning organization is `organizationId`.
 */
export async function runRecipientBrandFetch(args: {
	projectId: string;
	organizationId: string;
	userId: string;
	automatic: boolean;
	signal?: AbortSignal;
	context: AuditRequestContext;
}): Promise<BrandFetchAttemptView | null> {
	const { projectId, organizationId, userId, context } = args;
	const brand = await getRecipientBrand(projectId);
	// A row left behind in another organization has no website here.
	const stored =
		brand?.organizationId === organizationId ? brand.website : null;
	if (!stored) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Add the recipient's website first",
		});
	}
	const website = fetchableWebsite(stored);
	const host = new URL(website).hostname;

	return runBrandFetchAttempt<{
		name: string | null;
		colors: string[];
		logoPng: Buffer | null;
	}>({
		subject: "recipient",
		subjectId: projectId,
		organizationId,
		userId,
		automatic: args.automatic,
		signal: args.signal,
		website,
		readAttempt: () =>
			getRecipientBrandSuggestion({ projectId, organizationId }),
		startAttempt: (attempt) =>
			startRecipientBrandSuggestion({
				projectId,
				organizationId,
				website,
				requestedById: userId,
				...attempt,
			}),
		fetch: async (signal) => {
			const result = await fetchWebsiteBrand(website, { signal });
			if (result.ok) {
				return {
					ok: true,
					auditCode: "ok",
					value: {
						name: result.name,
						colors: result.colors,
						logoPng: result.logoPng,
					},
				};
			}
			// The page was read but no logo came of it: the colours and the
			// name it declared are still a suggestion worth showing.
			if (result.colors.length > 0 || result.name) {
				return {
					ok: true,
					auditCode: result.code,
					value: {
						name: result.name,
						colors: result.colors,
						logoPng: null,
					},
				};
			}
			return { ok: false, code: result.code };
		},
		audit: (code, succeeded) =>
			recordAuditFromRequest(context, {
				action: "project.recipient_brand.fetched",
				category: "project",
				outcome: succeeded ? "success" : "failure",
				organizationId,
				projectId,
				resource: { type: "project", id: projectId, name: null },
				metadata: { host, code },
			}),
		finishSuccess: async (requestId, value) => {
			let logoKey: string | null = null;
			let logoHash: string | null = null;
			if (value.logoPng) {
				logoKey = `${recipientSuggestedLogoPrefix(projectId)}${requestId}.png`;
				await getStorageProvider().uploadFile(logoKey, value.logoPng, {
					bucket: recipientBrandBucket(),
					contentType: "image/png",
				});
				logoHash = createHash("sha256")
					.update(value.logoPng)
					.digest("hex");
			}
			let finished: FinishRecipientBrandSuggestionResult;
			try {
				finished = await finishRecipientBrandSuggestion({
					projectId,
					requestId,
					website,
					outcome: {
						ok: true,
						name: value.name,
						colors: value.colors,
						logoKey,
						logoHash,
					},
					fetchedAt: new Date(),
				});
			} catch (error) {
				// The runner finishes the attempt as failed, so the logo it
				// stored goes too, unless the write did commit and only its
				// answer was lost: then the row points at it and it stays.
				if (logoKey) {
					const current = await getRecipientBrandSuggestion({
						projectId,
						organizationId,
					}).catch(() => null);
					if (current?.logoKey !== logoKey) {
						await deleteRecipientBrandObjects(projectId, [logoKey]);
					}
				}
				throw error;
			}
			if (!finished.applied) {
				// Superseded: nothing references the logo this attempt stored.
				if (logoKey) {
					await deleteRecipientBrandObjects(projectId, [logoKey]);
				}
				return false;
			}
			if (finished.previousLogoKey) {
				await deleteRecipientBrandObjects(projectId, [
					finished.previousLogoKey,
				]);
			}
			return true;
		},
		finishFailure: async (requestId, failureCode) => {
			const finished = await finishRecipientBrandSuggestion({
				projectId,
				requestId,
				website,
				outcome: { ok: false, failureCode },
				fetchedAt: new Date(),
			});
			return finished.applied;
		},
	});
}
