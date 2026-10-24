/**
 * The website brand fetch attempt (Fizzy #2946), with no network and no
 * database: the extractors are replaced, and the fetch rows live in memory
 * under the same guards their queries apply (a start only while the stored
 * website is the one fetched, a finish only for the attempt still RUNNING).
 * Everything else is the runner's own: the join window, the limits and their
 * order, the deadline, the logo object and its cleanup, and the audit row.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Attempt {
	website: string;
	requestId: string;
	status: string;
	failureCode: string | null;
	requestedById: string | null;
	requestedAt: Date;
}

const { world, mocks, storage } = vi.hoisted(() => ({
	world: {
		kit: null as { website: string | null } | null,
		site: null as
			| (Attempt & {
					resultWebsite: string | null;
					primaryColor: string | null;
					accentColors: string[];
			  })
			| null,
		recipient: null as {
			organizationId: string;
			name: string | null;
			website: string | null;
			colors: string[];
			logoKey: string | null;
		} | null,
		suggestion: null as
			| (Attempt & {
					organizationId: string;
					resultWebsite: string | null;
					name: string | null;
					colors: string[];
					logoKey: string | null;
					logoHash: string | null;
			  })
			| null,
		limits: new Map<string, number>(),
		limiterDown: false,
		/** Runs inside a finish, before it checks its guard. */
		beforeFinish: null as null | (() => void),
		/** Makes the next recipient success finish throw, after committing or not. */
		finishThrows: null as null | { afterCommit: boolean },
	},
	mocks: {
		fetchVendorBrand: vi.fn(),
		fetchWebsiteBrand: vi.fn(),
		checkRateLimit: vi.fn(),
		recordAudit: vi.fn(),
	},
	storage: {
		uploadFile: vi.fn(),
		deleteObjects: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {},
	canEditProject: vi.fn(),
	hasProjectAccess: vi.fn(),
	isOrganizationMember: vi.fn(),
	isRecipientLogoKeyForProject: vi.fn(),
	recipientLogoKeyPrefix: vi.fn(),
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
	getBrandKit: async (organizationId: string) =>
		world.kit ? { organizationId, ...world.kit } : null,
	getBrandSiteFetch: async () => (world.site ? { ...world.site } : null),
	startBrandSiteFetch: async (input: {
		website: string;
		requestId: string;
		requestedById: string;
		requestedAt: Date;
		failureCode?: string;
	}) => {
		if (!world.kit?.website || world.kit.website !== input.website) {
			return "stale";
		}
		world.site = {
			resultWebsite: null,
			primaryColor: null,
			accentColors: [],
			...world.site,
			website: input.website,
			requestId: input.requestId,
			status: input.failureCode ? "FAILED" : "RUNNING",
			failureCode: input.failureCode ?? null,
			requestedById: input.requestedById,
			requestedAt: input.requestedAt,
		};
		return "started";
	},
	finishBrandSiteFetch: async (input: {
		requestId: string;
		website: string;
		outcome:
			| { ok: true; primaryColor: string; accentColors: string[] }
			| { ok: false; failureCode: string };
	}) => {
		world.beforeFinish?.();
		const row = world.site;
		if (
			!row ||
			row.requestId !== input.requestId ||
			row.status !== "RUNNING"
		) {
			return false;
		}
		if (input.outcome.ok) {
			Object.assign(row, {
				status: "SUCCEEDED",
				failureCode: null,
				resultWebsite: input.website,
				primaryColor: input.outcome.primaryColor,
				accentColors: input.outcome.accentColors,
			});
		} else {
			Object.assign(row, {
				status: "FAILED",
				failureCode: input.outcome.failureCode,
			});
		}
		return true;
	},
	getRecipientBrand: async () =>
		world.recipient ? { ...world.recipient } : null,
	getRecipientBrandSuggestion: async () =>
		world.suggestion ? { ...world.suggestion } : null,
	startRecipientBrandSuggestion: async (input: {
		organizationId: string;
		website: string;
		requestId: string;
		requestedById: string;
		requestedAt: Date;
		failureCode?: string;
	}) => {
		if (
			!world.recipient?.website ||
			world.recipient.website !== input.website ||
			world.recipient.organizationId !== input.organizationId
		) {
			return "stale";
		}
		world.suggestion = {
			resultWebsite: null,
			name: null,
			colors: [],
			logoKey: null,
			logoHash: null,
			...world.suggestion,
			organizationId: input.organizationId,
			website: input.website,
			requestId: input.requestId,
			status: input.failureCode ? "FAILED" : "RUNNING",
			failureCode: input.failureCode ?? null,
			requestedById: input.requestedById,
			requestedAt: input.requestedAt,
		};
		return "started";
	},
	finishRecipientBrandSuggestion: async (input: {
		requestId: string;
		website: string;
		outcome:
			| {
					ok: true;
					name: string | null;
					colors: string[];
					logoKey: string | null;
					logoHash: string | null;
			  }
			| { ok: false; failureCode: string };
	}) => {
		world.beforeFinish?.();
		const row = world.suggestion;
		if (input.outcome.ok && world.finishThrows) {
			const { afterCommit } = world.finishThrows;
			world.finishThrows = null;
			if (afterCommit && row) {
				Object.assign(row, {
					status: "SUCCEEDED",
					logoKey: input.outcome.logoKey,
				});
			}
			throw new Error("connection reset");
		}
		if (
			!row ||
			row.requestId !== input.requestId ||
			row.status !== "RUNNING"
		) {
			return { applied: false };
		}
		if (!input.outcome.ok) {
			Object.assign(row, {
				status: "FAILED",
				failureCode: input.outcome.failureCode,
			});
			return { applied: true, previousLogoKey: null };
		}
		const previous = row.logoKey;
		Object.assign(row, {
			status: "SUCCEEDED",
			failureCode: null,
			resultWebsite: input.website,
			name: input.outcome.name,
			colors: input.outcome.colors,
			logoKey: input.outcome.logoKey,
			logoHash: input.outcome.logoHash,
		});
		return {
			applied: true,
			previousLogoKey:
				previous && previous !== input.outcome.logoKey
					? previous
					: null,
		};
	},
}));

vi.mock("@repo/integrations/website-brand", async () => ({
	...(await vi.importActual<
		typeof import("@repo/integrations/website-brand")
	>("@repo/integrations/website-brand")),
	fetchVendorBrand: mocks.fetchVendorBrand,
	fetchWebsiteBrand: mocks.fetchWebsiteBrand,
}));

vi.mock("@repo/storage", () => ({ getStorageProvider: () => storage }));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../audit", () => ({ recordAuditFromRequest: mocks.recordAudit }));

vi.mock("../rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

import {
	BRAND_FETCH_ORGANIZATION_RATE_LIMIT,
	runBrandSiteFetch,
	runRecipientBrandFetch,
} from "../brand-fetch";

const ORG = "org_1";
const PROJECT = "proj_1";
const USER = "user_admin";
const WEBSITE = "https://example.com";
const LOGO_PNG = Buffer.from("normalized-png-bytes");
const SUGGESTED_KEY = new RegExp(
	`^project-brand/${PROJECT}/recipient-brand/suggested/[0-9a-f-]{36}\\.png$`,
);
const context = {
	user: { id: USER, name: "Admin", email: "dev@example.com" },
	session: { id: "session-1", activeOrganizationId: ORG },
};

function site(
	overrides: Partial<Parameters<typeof runBrandSiteFetch>[0]> = {},
) {
	return runBrandSiteFetch({
		organizationId: ORG,
		userId: USER,
		automatic: false,
		context,
		...overrides,
	});
}

function recipient(
	overrides: Partial<Parameters<typeof runRecipientBrandFetch>[0]> = {},
) {
	return runRecipientBrandFetch({
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		automatic: false,
		context,
		...overrides,
	});
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	world.kit = { website: WEBSITE };
	world.site = null;
	world.recipient = {
		organizationId: ORG,
		name: "Typed Name",
		website: WEBSITE,
		colors: ["#112233"],
		logoKey: null,
	};
	world.suggestion = null;
	world.limits.clear();
	world.limiterDown = false;
	world.beforeFinish = null;
	world.finishThrows = null;
	mocks.checkRateLimit.mockImplementation(
		async (key: string, limit: number) => {
			if (world.limiterDown) {
				return {
					allowed: false,
					remaining: 0,
					resetInSeconds: 60,
					statusCode: 503,
				};
			}
			const used = (world.limits.get(key) ?? 0) + 1;
			world.limits.set(key, used);
			return {
				allowed: used <= limit,
				remaining: Math.max(0, limit - used),
				resetInSeconds: 600,
			};
		},
	);
	mocks.fetchVendorBrand.mockResolvedValue({
		ok: true,
		primaryColor: "#0a2540",
		accentColors: ["#635bff"],
		source: "brand_page",
	});
	mocks.fetchWebsiteBrand.mockResolvedValue({
		ok: true,
		logoPng: LOGO_PNG,
		colors: ["#0a66c2"],
		finalHost: "example.com",
		name: "Example Co",
	});
	storage.uploadFile.mockResolvedValue({ url: "x", pathname: "x" });
	storage.deleteObjects.mockResolvedValue({ deleted: [], errors: [] });
});

describe("runBrandSiteFetch", () => {
	it("fetches the stored website and records the colours in the fetch row only", async () => {
		const attempt = await site();

		expect(mocks.fetchVendorBrand).toHaveBeenCalledWith(WEBSITE, {
			signal: expect.any(AbortSignal),
		});
		expect(attempt).toEqual({
			status: "SUCCEEDED",
			failureCode: null,
			website: WEBSITE,
			requestedAt: expect.any(Date),
		});
		expect(world.site).toMatchObject({
			status: "SUCCEEDED",
			resultWebsite: WEBSITE,
			primaryColor: "#0a2540",
			accentColors: ["#635bff"],
			requestedById: USER,
		});
		expect(world.kit).toEqual({ website: WEBSITE });
	});

	it("refuses without a stored website and fetches nothing", async () => {
		world.kit = { website: null };

		expect(await rejection(site())).toBe("BAD_REQUEST");
		world.kit = null;
		expect(await rejection(site())).toBe("BAD_REQUEST");
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
	});

	it("checks the per-user and the organization's site limit before any outbound request", async () => {
		await site();

		expect(
			mocks.checkRateLimit.mock.calls.map((c) => c.slice(0, 3)),
		).toEqual([
			[`website-brand:${USER}`, 10, 10 * 60_000],
			[`website-brand:org:${ORG}:site`, 20, 60 * 60_000],
		]);
		const lastLimit = Math.max(
			...mocks.checkRateLimit.mock.invocationCallOrder,
		);
		expect(lastLimit).toBeLessThan(
			mocks.fetchVendorBrand.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("audits each outbound attempt with the host and a fixed code", async () => {
		await site();
		mocks.fetchVendorBrand.mockResolvedValueOnce({
			ok: false,
			code: "no_colors",
		});
		await site();

		expect(mocks.recordAudit.mock.calls.map((c) => c[1])).toEqual([
			{
				action: "org.brand_kit.site_fetched",
				category: "org",
				outcome: "success",
				organizationId: ORG,
				resource: { type: "organization", id: ORG, name: null },
				metadata: { host: "example.com", code: "brand_page" },
			},
			{
				action: "org.brand_kit.site_fetched",
				category: "org",
				outcome: "failure",
				organizationId: ORG,
				resource: { type: "organization", id: ORG, name: null },
				metadata: { host: "example.com", code: "no_colors" },
			},
		]);
	});

	it("audits a success with the tier its colours came from", async () => {
		for (const source of ["brand_page", "theme_color", "manifest"]) {
			mocks.fetchVendorBrand.mockResolvedValueOnce({
				ok: true,
				primaryColor: "#0a2540",
				accentColors: [],
				source,
			});
			await site();
		}

		expect(
			mocks.recordAudit.mock.calls.map((c) => c[1].metadata.code),
		).toEqual(["brand_page", "theme_color", "manifest"]);
	});

	it("refuses a stored website the host rule refuses before any limit or fetch", async () => {
		for (const website of [
			"https://my_site.example.com",
			"https://[2001:db8::1]",
			"https://192.0.2.10",
		]) {
			world.kit = { website };

			expect(await rejection(site())).toBe("BAD_REQUEST");
			expect(await rejection(site({ automatic: true }))).toBe(
				"BAD_REQUEST",
			);
		}
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
		expect(world.site).toBeNull();
	});

	it("names no host when it refuses a stored website", async () => {
		world.kit = { website: "https://my_site.example.com" };

		const error = await site().catch((caught: Error) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("my_site");
	});

	it("a failed re-fetch keeps the last result and records the fetch's code", async () => {
		await site();
		mocks.fetchVendorBrand.mockResolvedValueOnce({
			ok: false,
			code: "blocked",
		});

		const attempt = await site();

		expect(attempt).toMatchObject({
			status: "FAILED",
			failureCode: "blocked",
		});
		expect(world.site).toMatchObject({
			status: "FAILED",
			failureCode: "blocked",
			primaryColor: "#0a2540",
			resultWebsite: WEBSITE,
		});
	});

	it("records a thrown fetch as failed and answers instead of throwing", async () => {
		mocks.fetchVendorBrand.mockRejectedValueOnce(new Error("boom"));

		expect(await site()).toMatchObject({
			status: "FAILED",
			failureCode: "failed",
		});
		expect(world.site?.failureCode).toBe("failed");
	});

	it("records an aborted request as timed out, even when the fetch never settles", async () => {
		const controller = new AbortController();
		mocks.fetchVendorBrand.mockImplementationOnce(
			() => new Promise(() => {}),
		);

		const running = site({ signal: controller.signal });
		await vi.waitFor(() =>
			expect(mocks.fetchVendorBrand).toHaveBeenCalled(),
		);
		controller.abort();

		expect(await running).toMatchObject({
			status: "FAILED",
			failureCode: "timed_out",
		});
		expect(mocks.recordAudit.mock.calls[0]?.[1].metadata).toEqual({
			host: "example.com",
			code: "timed_out",
		});
	});

	it("records an abort the extractor answered with its own code as timed out", async () => {
		const controller = new AbortController();
		mocks.fetchVendorBrand.mockImplementationOnce(async () => {
			controller.abort();
			return { ok: false, code: "unreachable" };
		});

		expect(await site({ signal: controller.signal })).toMatchObject({
			failureCode: "timed_out",
		});
	});

	it("passes a signal that aborts with the request", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		mocks.fetchVendorBrand.mockImplementationOnce(
			async (_website: string, options: { signal: AbortSignal }) => {
				seen = options.signal;
				controller.abort();
				return { ok: false, code: "unreachable" };
			},
		);

		await site({ signal: controller.signal });

		expect(seen?.aborted).toBe(true);
	});

	it("a double submit returns the running attempt and makes one outbound sequence", async () => {
		const pending = deferred<unknown>();
		mocks.fetchVendorBrand.mockImplementationOnce(() => pending.promise);

		const first = site();
		await vi.waitFor(() =>
			expect(mocks.fetchVendorBrand).toHaveBeenCalledTimes(1),
		);
		const second = await site();

		expect(second).toMatchObject({ status: "RUNNING", website: WEBSITE });
		pending.resolve({
			ok: true,
			primaryColor: "#0a2540",
			accentColors: [],
			source: "theme_color",
		});
		expect(await first).toMatchObject({ status: "SUCCEEDED" });
		expect(mocks.fetchVendorBrand).toHaveBeenCalledTimes(1);
		// The joined call made no request, so it is neither limited nor audited.
		expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("does not join a running attempt older than a minute, or one for another website", async () => {
		world.site = {
			website: WEBSITE,
			requestId: "old",
			status: "RUNNING",
			failureCode: null,
			requestedById: USER,
			requestedAt: new Date(Date.now() - 61_000),
			resultWebsite: null,
			primaryColor: null,
			accentColors: [],
		};

		expect(await site()).toMatchObject({ status: "SUCCEEDED" });

		world.site.status = "RUNNING";
		world.site.requestedAt = new Date();
		world.site.website = "https://other.example.com";
		expect(await site()).toMatchObject({ status: "SUCCEEDED" });
		expect(mocks.fetchVendorBrand).toHaveBeenCalledTimes(2);
	});

	it("a newer attempt wins and the superseded finish writes nothing", async () => {
		// While this attempt fetches, the website changes and a fetch of the
		// new one starts and succeeds.
		mocks.fetchVendorBrand.mockImplementationOnce(async () => {
			world.kit = { website: "https://new.example.com" };
			world.site = {
				website: "https://new.example.com",
				requestId: "newer",
				status: "SUCCEEDED",
				failureCode: null,
				requestedById: USER,
				requestedAt: new Date(),
				resultWebsite: "https://new.example.com",
				primaryColor: "#7c3aed",
				accentColors: [],
			};
			return {
				ok: true,
				primaryColor: "#0a2540",
				accentColors: [],
				source: "brand_page",
			};
		});

		const attempt = await site();

		expect(world.site).toMatchObject({
			requestId: "newer",
			primaryColor: "#7c3aed",
		});
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			website: "https://new.example.com",
		});
	});

	it("starts nothing when the stored website changed before the start", async () => {
		mocks.checkRateLimit.mockImplementationOnce(async () => {
			world.kit = { website: "https://new.example.com" };
			return { allowed: true, remaining: 9, resetInSeconds: 600 };
		});

		expect(await site()).toBeNull();
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("records the 21st automatic call in an hour as FAILED rate_limited and fetches nothing", async () => {
		world.limits.set(
			`website-brand:org:${ORG}:site`,
			BRAND_FETCH_ORGANIZATION_RATE_LIMIT.limit,
		);

		const attempt = await site({ automatic: true });

		expect(attempt).toEqual({
			status: "FAILED",
			failureCode: "rate_limited",
			website: WEBSITE,
			requestedAt: expect.any(Date),
		});
		expect(world.site).toMatchObject({
			status: "FAILED",
			failureCode: "rate_limited",
		});
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("answers an explicit call over the limit with TOO_MANY_REQUESTS and records nothing", async () => {
		world.limits.set(`website-brand:${USER}`, 10);

		expect(await rejection(site())).toBe("TOO_MANY_REQUESTS");
		expect(world.site).toBeNull();
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
		// The per-user refusal does not use up the organization's budget.
		expect(world.limits.has(`website-brand:org:${ORG}:site`)).toBe(false);
	});

	it("answers an explicit call with SERVICE_UNAVAILABLE when the limiter is down", async () => {
		world.limiterDown = true;

		expect(await rejection(site())).toBe("SERVICE_UNAVAILABLE");
		expect(mocks.fetchVendorBrand).not.toHaveBeenCalled();
	});

	it("keeps the site and recipient organization limits apart", async () => {
		world.limits.set(`website-brand:org:${ORG}:site`, 20);

		expect(await recipient({ automatic: true })).toMatchObject({
			status: "SUCCEEDED",
		});
	});
});

describe("runRecipientBrandFetch", () => {
	it("stores the logo under the suggestion prefix and leaves the recipient brand unchanged", async () => {
		const before = structuredClone(world.recipient);

		const attempt = await recipient();

		const [key, bytes, options] = storage.uploadFile.mock.calls[0] ?? [];
		expect(key).toMatch(SUGGESTED_KEY);
		expect(key).toContain(world.suggestion?.requestId);
		expect(bytes).toBe(LOGO_PNG);
		expect(options).toEqual({
			bucket: "project-contexts",
			contentType: "image/png",
		});
		expect(world.suggestion).toMatchObject({
			status: "SUCCEEDED",
			resultWebsite: WEBSITE,
			name: "Example Co",
			colors: ["#0a66c2"],
			logoKey: key,
			logoHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(attempt).toMatchObject({ status: "SUCCEEDED" });
		// The person's own values stay as typed: a fetch only suggests.
		expect(world.recipient).toEqual(before);
	});

	it("records the logo's SHA-256", async () => {
		await recipient();

		const { createHash } = await import("node:crypto");
		expect(world.suggestion?.logoHash).toBe(
			createHash("sha256").update(LOGO_PNG).digest("hex"),
		);
	});

	it("keeps a manual recipient colour when the fetch finds another one", async () => {
		mocks.fetchWebsiteBrand.mockResolvedValueOnce({
			ok: true,
			logoPng: LOGO_PNG,
			colors: ["#ff8800"],
			finalHost: "example.com",
			name: "Fetched Name",
		});

		await recipient();

		expect(world.recipient?.colors).toEqual(["#112233"]);
		expect(world.recipient?.name).toBe("Typed Name");
		expect(world.suggestion?.colors).toEqual(["#ff8800"]);
	});

	it("counts a page with colours or a name but no logo as a success without a logo", async () => {
		mocks.fetchWebsiteBrand.mockResolvedValueOnce({
			ok: false,
			code: "no_logo",
			colors: ["#0d9488"],
			name: null,
		});

		expect(await recipient()).toMatchObject({ status: "SUCCEEDED" });
		expect(world.suggestion).toMatchObject({
			colors: ["#0d9488"],
			logoKey: null,
			logoHash: null,
		});
		expect(storage.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordAudit.mock.calls[0]?.[1]).toMatchObject({
			outcome: "success",
			metadata: { host: "example.com", code: "no_logo" },
		});
	});

	it("records FAILED with the fetch's code when nothing was found", async () => {
		mocks.fetchWebsiteBrand.mockResolvedValueOnce({
			ok: false,
			code: "blocked",
			colors: [],
			name: null,
		});

		expect(await recipient()).toMatchObject({
			status: "FAILED",
			failureCode: "blocked",
		});
		expect(storage.uploadFile).not.toHaveBeenCalled();
		expect(mocks.recordAudit.mock.calls[0]?.[1]).toEqual({
			action: "project.recipient_brand.fetched",
			category: "project",
			outcome: "failure",
			organizationId: ORG,
			projectId: PROJECT,
			resource: { type: "project", id: PROJECT, name: null },
			metadata: { host: "example.com", code: "blocked" },
		});
	});

	it("records a storage failure as failed, after the audit row", async () => {
		storage.uploadFile.mockRejectedValueOnce(new Error("storage down"));

		expect(await recipient()).toMatchObject({
			status: "FAILED",
			failureCode: "failed",
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(world.suggestion?.logoKey).toBeNull();
	});

	it("deletes the logo it stored when a newer attempt replaced it", async () => {
		world.beforeFinish = () => {
			if (world.suggestion) {
				world.suggestion.requestId = "newer";
			}
		};

		await recipient();

		const stored = storage.uploadFile.mock.calls[0]?.[0];
		expect(storage.deleteObjects).toHaveBeenCalledWith([stored], {
			bucket: "project-contexts",
		});
		expect(world.suggestion?.logoKey).toBeNull();
	});

	it("deletes the previous suggested logo after a newer result applies", async () => {
		await recipient();
		const first = world.suggestion?.logoKey;

		await recipient();

		expect(storage.deleteObjects).toHaveBeenCalledTimes(1);
		expect(storage.deleteObjects).toHaveBeenCalledWith([first], {
			bucket: "project-contexts",
		});
		expect(world.suggestion?.logoKey).not.toBe(first);
	});

	it("never throws when a logo cleanup fails", async () => {
		await recipient();
		storage.deleteObjects.mockRejectedValueOnce(new Error("storage down"));

		expect(await recipient()).toMatchObject({ status: "SUCCEEDED" });
	});

	it("deletes the logo it stored when the finish throws, and records failed", async () => {
		world.finishThrows = { afterCommit: false };

		const attempt = await recipient();

		const stored = storage.uploadFile.mock.calls[0]?.[0];
		expect(stored).toMatch(SUGGESTED_KEY);
		expect(storage.deleteObjects).toHaveBeenCalledWith([stored], {
			bucket: "project-contexts",
		});
		expect(attempt).toMatchObject({
			status: "FAILED",
			failureCode: "failed",
		});
		expect(world.suggestion).toMatchObject({
			status: "FAILED",
			failureCode: "failed",
			logoKey: null,
		});
	});

	it("keeps the logo when the finish committed but its answer was lost", async () => {
		world.finishThrows = { afterCommit: true };

		await recipient();

		const stored = storage.uploadFile.mock.calls[0]?.[0];
		expect(world.suggestion?.logoKey).toBe(stored);
		expect(storage.deleteObjects).not.toHaveBeenCalled();
	});

	it("refuses a stored recipient website the host rule refuses before any limit or fetch", async () => {
		for (const website of [
			"https://my_site.example.com",
			"https://[2001:db8::1]",
		]) {
			if (world.recipient) {
				world.recipient.website = website;
			}

			expect(await rejection(recipient())).toBe("BAD_REQUEST");
			expect(await rejection(recipient({ automatic: true }))).toBe(
				"BAD_REQUEST",
			);
		}
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
		expect(world.suggestion).toBeNull();
	});

	it("refuses a recipient row of another organization as having no website", async () => {
		world.recipient = {
			organizationId: "org_2",
			name: null,
			website: WEBSITE,
			colors: [],
			logoKey: null,
		};

		expect(await rejection(recipient())).toBe("BAD_REQUEST");
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
	});

	it("uses the organization's recipient limit key", async () => {
		await recipient();

		expect(mocks.checkRateLimit.mock.calls.map((c) => c[0])).toEqual([
			`website-brand:${USER}`,
			`website-brand:org:${ORG}:recipient`,
		]);
	});
});

describe("no model reach", () => {
	// Fetched text must never reach a prompt: the runner and both procedures
	// import no model, provider or prompt code.
	const MODEL_IMPORT =
		/from\s+["'](?:@repo\/ai(?:\/[^"']*)?|ai|@ai-sdk\/[^"']+|@repo\/temporal[^"']*|@repo\/agents[^"']*|@langchain\/[^"']+|openai|@anthropic-ai\/[^"']+)["']/;

	it.each([
		"lib/brand-fetch.ts",
		"modules/organizations/procedures/brand-kit/fetch-brand-site.ts",
		"modules/projects/procedures/recipient-brand/request-recipient-brand-fetch.ts",
	])("%s imports no model or prompt module", (file) => {
		const source = readFileSync(resolve(__dirname, "../..", file), "utf8");
		expect(source).not.toMatch(MODEL_IMPORT);
	});
});
