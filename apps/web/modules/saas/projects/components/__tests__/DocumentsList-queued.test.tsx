/**
 * Fizzy #2199 — the Documents tab under the dependency-aware generation queue.
 *
 * A document whose generation is accepted but waiting on the project's own
 * context work can sit in QUEUED for the better part of an hour. Everything
 * here is about that wait being legible and honest:
 *
 *  1. QUEUED renders as queued, with a real `statusConfig` entry rather than
 *     the `?? DRAFT` fallback that would call a waiting run an untouched draft.
 *  2. The reason is visible text, not tooltip-only — the pill is a
 *     non-focusable `<span>`, so hover-only copy is unreachable by keyboard and
 *     touch, and the reason IS the requirement.
 *  3. The wait keeps the list polling past the ten-minute floor built for runs
 *     that died mid-flight — at a cadence that backs off as the wait proves
 *     long, mirroring the server probe that actually owns it.
 *  4. Nothing on the card offers to start the generation again.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../packages/i18n/translations/en.json";

// ── jsdom polyfills ──────────────────────────────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const { documentsListMock } = vi.hoisted(() => ({
	documentsListMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = () => ({
		mutationOptions: (opts: unknown) => ({ ...(opts ?? {}) }),
	});
	return {
		orpc: {
			projects: {
				documents: {
					list: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: [
								"projects.documents.list",
								input,
							] as const,
							queryFn: () => documentsListMock(input),
						}),
						queryKey: ({ input }: { input: unknown }) => [
							"projects.documents.list",
							input,
						],
					},
					delete: mutation(),
					deleteAll: mutation(),
					generate: mutation(),
					setActive: mutation(),
				},
			},
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * Resolve real copy from `en.json` rather than a hand-copied map. The point of
 * these assertions is that a reader sees a reason, so a mock that echoes key
 * names back would pass while the UI showed `queued.waitingOn`.
 */
vi.mock("next-intl", () => {
	function resolve(path: string): string {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				en,
			);
		if (typeof value !== "string") {
			throw new Error(`missing translation: ${path}`);
		}
		return value;
	}
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) => {
			let out = resolve(`${namespace}.${key}`);
			for (const [name, value] of Object.entries(values ?? {})) {
				out = out.replaceAll(`{${name}}`, String(value));
			}
			return out;
		};
		t.raw = (key: string) => resolve(`${namespace}.${key}`);
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

vi.mock("../CreateDocumentDialog", () => ({
	CreateDocumentDialog: () => null,
}));
vi.mock("../DocumentDownloadDropdown", () => ({
	DocumentDownloadDropdown: () => null,
}));
vi.mock("../DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: ({ title }: { title: string }) => <>{title}</>,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { isDocumentGenerationStale } from "../../lib/document-generation-timestamp";
import {
	getDocumentsPollInterval,
	isDocumentGenerationRunning,
} from "../../lib/document-pipeline";
import {
	canBeMadeActive,
	DocumentsList,
	resolveQueueReasonKey,
	resolveRegenerateToastKey,
} from "../DocumentsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Architecture Overview",
		type: "ARCHITECTURE",
		status: "QUEUED",
		source: "GENERATED",
		isActive: true,
		wordCount: 0,
		content: "",
		generationProgress: 0,
		generationError: null,
		generationQueueReason: "codebaseIndexing",
		generationStartedAt: new Date("2026-09-07T10:00:00Z"),
		updatedAt: new Date("2026-09-07T10:00:00Z"),
		createdAt: new Date("2026-09-07T10:00:00Z"),
		_count: { versions: 0 },
		...overrides,
	};
}

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

async function renderWithDocuments(documents: Record<string, unknown>[]) {
	documentsListMock.mockResolvedValue({
		documents,
		total: documents.length,
		hasMore: false,
	});
	wrap(<DocumentsList projectId="proj_1" enableDelete />);
	return screen.findByText(String(documents[0].title));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("DocumentsList — queued documents", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
	});

	it("renders a queued document as queued, not as a draft", async () => {
		await renderWithDocuments([makeDocument()]);

		expect(screen.getByText("Queued")).toBeInTheDocument();
		expect(screen.queryByText("Draft")).not.toBeInTheDocument();
	});

	it("shows the queue reason as visible text, with no hover needed", async () => {
		await renderWithDocuments([makeDocument()]);

		const reason = screen.getByText("Waiting on repository indexing");
		expect(reason).toBeVisible();
		// Not inside the screen-reader-only supplement — this is the copy a
		// sighted keyboard or touch user has to be able to read without hovering
		// a non-focusable pill.
		expect(reason).not.toHaveClass("sr-only");
		expect(reason).toHaveAttribute(
			"title",
			expect.stringContaining("repository indexing"),
		);
	});

	it("says it is still working out the reason before the first probe reports", async () => {
		await renderWithDocuments([
			makeDocument({ generationQueueReason: null }),
		]);

		expect(
			screen.getByText("Working out what this is waiting for…"),
		).toBeInTheDocument();
	});

	it("gives the queued badge an accessible name that carries the state in text", async () => {
		await renderWithDocuments([makeDocument()]);

		const supplement = screen.getByText(
			/Queued — waiting on repository indexing/,
		);
		expect(supplement).toHaveClass("sr-only");

		// The pill is not focusable, so the tooltip alone would never be
		// announced; the `sr-only` child is what makes its name say more than
		// the bare status word.
		const badge = supplement.parentElement;
		expect(badge?.textContent).toContain("Queued");
		expect(badge?.textContent).toMatch(/waiting on repository indexing/);
	});

	it("guards the badge's indefinite pulse behind prefers-reduced-motion", async () => {
		await renderWithDocuments([makeDocument()]);

		const badge = screen.getByText(
			/Queued — waiting on repository indexing/,
		).parentElement;
		const pulsing = badge?.querySelector("[class*='animate-pulse']");

		// The wait this marks can outlast an hour, so an unguarded pulse is
		// exactly the kind of animation `prefers-reduced-motion` exists for.
		expect(pulsing).not.toBeNull();
		expect(pulsing?.getAttribute("class")).toContain(
			"motion-safe:animate-pulse",
		);
		expect(pulsing?.getAttribute("class")).not.toMatch(
			/(^|\s)animate-pulse(\s|$)/,
		);
	});

	it("offers no way to start the generation again", async () => {
		await renderWithDocuments([
			makeDocument({ isActive: false, generationQueueReason: null }),
		]);

		expect(
			screen.queryByRole("button", { name: /regenerate/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /set as active/i }),
		).not.toBeInTheDocument();
	});
});

describe("canBeMadeActive", () => {
	it("excludes a queued document, which has no body to be canonical with", () => {
		expect(canBeMadeActive("QUEUED")).toBe(false);
		expect(canBeMadeActive("GENERATING")).toBe(false);
		expect(canBeMadeActive("FAILED")).toBe(false);
	});

	it("still allows every status that has content behind it", () => {
		for (const status of ["DRAFT", "IN_PROGRESS", "REVIEW", "COMPLETE"]) {
			expect(canBeMadeActive(status)).toBe(true);
		}
	});
});

describe("resolveQueueReasonKey", () => {
	it("passes through each known dependency category", () => {
		for (const category of [
			"codebaseIndexing",
			"sourceExtraction",
			"linkedSiteCrawl",
			"securityScan",
			"monitorIngestion",
			"prerequisiteDocument",
		]) {
			expect(resolveQueueReasonKey(category)).toBe(category);
			// Every category has to be sayable, or the card renders a raw
			// enum-ish string at the reader.
			expect(
				(
					en.projects.documents.queued.reasons as Record<
						string,
						string
					>
				)[category],
			).toBeTruthy();
		}
	});

	it("separates 'no answer yet' from 'an answer this build does not know'", () => {
		expect(resolveQueueReasonKey(null)).toBeNull();
		expect(resolveQueueReasonKey(undefined)).toBeNull();
		expect(resolveQueueReasonKey("")).toBeNull();
		expect(resolveQueueReasonKey("somethingNewer")).toBe("unknown");
	});
});

describe("getDocumentsPollInterval", () => {
	const now = Date.UTC(2026, 8, 7, 12, 0, 0);
	const elevenMinutesAgo = new Date(now - 11 * 60 * 1000);
	const oneMinuteAgo = new Date(now - 60 * 1000);
	const justNow = new Date(now);

	it("keeps polling a queued document past the ten-minute floor", () => {
		// The floor exists to give up on a run that died mid-flight. A
		// dependency wait can outlast it by the best part of an hour, and
		// ageing one out froze the card on "Queued" for the rest of the session.
		expect(
			getDocumentsPollInterval(
				[
					{
						status: "QUEUED",
						generationStartedAt: elevenMinutesAgo,
						updatedAt: elevenMinutesAgo,
					},
				],
				now,
			),
		).not.toBe(false);
	});

	it("backs off a long wait instead of asking every three seconds", () => {
		// The server's own dependency probe doubles its delay toward five
		// minutes; the client is a viewer of that wait, not the thing that
		// ends it. A freshly-queued document still reads as live, and an
		// hour-long index wait costs a hundred-odd requests, not twelve hundred.
		const at = (startedAt: Date) =>
			getDocumentsPollInterval(
				[
					{
						status: "QUEUED",
						generationStartedAt: startedAt,
						updatedAt: startedAt,
					},
				],
				now,
			);

		expect(at(justNow)).toBe(3000);
		expect(at(new Date(now - 3000))).toBe(6000);
		expect(at(new Date(now - 9000))).toBe(12000);
		// Ceiling — never wider than half a minute, so the one state change
		// the row still has left is never more than that late.
		expect(at(oneMinuteAgo)).toBe(30_000);
		expect(at(elevenMinutesAgo)).toBe(30_000);
	});

	it("still ages out a generating document that has gone silent for the floor", () => {
		// The floor is a SILENCE ceiling, so it reads `updatedAt` — the last
		// server write. This row was accepted a minute ago and has written
		// nothing for eleven, which is the run-died-mid-flight case the ceiling
		// was built for.
		expect(
			getDocumentsPollInterval(
				[
					{
						status: "GENERATING",
						generationStartedAt: oneMinuteAgo,
						updatedAt: elevenMinutesAgo,
					},
				],
				now,
			),
		).toBe(false);
		expect(
			getDocumentsPollInterval(
				[
					{
						status: "GENERATING",
						generationStartedAt: oneMinuteAgo,
						updatedAt: oneMinuteAgo,
					},
				],
				now,
			),
		).toBe(3000);
	});

	/**
	 * The regression the clock was changed for. `generationStartedAt` is
	 * stamped when the request is ACCEPTED — it is the attempt's identity, held
	 * fixed so the server's guarded writes can compare against it — so a
	 * document that waited out a long dependency wait is already well past the
	 * ceiling the moment it starts producing output. Measured by that column
	 * this row stops polling and offers a Retry over a live generation.
	 */
	it("keeps polling a run that queued an hour ago and has just started writing", () => {
		const anHourAgo = new Date(now - 60 * 60 * 1000);
		const tenSecondsAgo = new Date(now - 10_000);

		expect(
			getDocumentsPollInterval(
				[
					{
						status: "GENERATING",
						generationStartedAt: anHourAgo,
						updatedAt: tenSecondsAgo,
					},
				],
				now,
			),
		).toBe(3000);
		// And the same row is not offered the stalled-run affordance.
		expect(
			isDocumentGenerationStale(
				"GENERATING",
				anHourAgo,
				tenSecondsAgo,
				now,
			),
		).toBe(false);
	});

	it("treats the ceiling itself as still alive, not already dead", () => {
		// Pins `>` against `>=`: exactly ten minutes of silence is the last
		// moment the row still polls, and a millisecond more is the first
		// moment it does not.
		const tenMinutes = 10 * 60 * 1000;
		const generating = (updatedAt: Date) =>
			getDocumentsPollInterval(
				[
					{
						status: "GENERATING",
						generationStartedAt: updatedAt,
						updatedAt,
					},
				],
				now,
			);

		expect(generating(new Date(now - tenMinutes))).toBe(3000);
		expect(generating(new Date(now - tenMinutes - 1))).toBe(false);
	});

	it("lets the most impatient document set the pace for the one request", () => {
		expect(
			getDocumentsPollInterval(
				[
					{
						status: "QUEUED",
						generationStartedAt: elevenMinutesAgo,
						updatedAt: elevenMinutesAgo,
					},
					{
						status: "GENERATING",
						generationStartedAt: oneMinuteAgo,
						updatedAt: oneMinuteAgo,
					},
				],
				now,
			),
		).toBe(3000);
	});

	it("does not poll a settled list", () => {
		expect(
			getDocumentsPollInterval(
				[
					{ status: "COMPLETE", updatedAt: oneMinuteAgo },
					{ status: "FAILED", updatedAt: oneMinuteAgo },
					{ status: "DRAFT", updatedAt: oneMinuteAgo },
				],
				now,
			),
		).toBe(false);
		expect(getDocumentsPollInterval(undefined, now)).toBe(false);
		expect(getDocumentsPollInterval([], now)).toBe(false);
	});
});

/**
 * The list's regenerate toast. The workflow id is derived from the request
 * rather than salted with the clock, so a duplicate start is a real outcome
 * here — two tabs, or one double-click — and the fixed "regeneration started"
 * that used to be shown regardless is false in exactly that case.
 */
describe("resolveRegenerateToastKey", () => {
	it("says a run began when one did", () => {
		expect(
			resolveRegenerateToastKey({
				outcome: "started",
				documentStatus: "QUEUED",
			}),
		).toBe("started");
	});

	it("does not claim a generation started when none did", () => {
		expect(
			resolveRegenerateToastKey({
				outcome: "alreadyInProgress",
				documentStatus: "GENERATING",
			}),
		).toBe("alreadyRunning");
	});

	it("words the duplicate from the live run's own state, not from a guess", () => {
		// Same outcome, two different truths: one run is still behind the
		// project's context work, the other is mid-sentence. Hardcoding either
		// word tells half the users something false.
		expect(
			resolveRegenerateToastKey({
				outcome: "alreadyInProgress",
				documentStatus: "QUEUED",
			}),
		).toBe("alreadyQueued");
		expect(
			resolveRegenerateToastKey({
				outcome: "alreadyInProgress",
				documentStatus: "GENERATING",
			}),
		).toBe("alreadyRunning");
	});

	it("resolves an unknown or absent outcome rather than throwing", () => {
		// A response from a deploy this bundle predates still has to leave the
		// list saying something — the invalidated row is the source of truth.
		for (const outcome of [
			"statusUnknown",
			"somethingNewer",
			null,
			undefined,
		]) {
			expect(
				resolveRegenerateToastKey({
					outcome,
					documentStatus: "GENERATING",
				}),
			).toBe("started");
		}
	});

	it("names only keys the shipped locales define", () => {
		// The helper returns a key now, so a typo would surface to users as a
		// raw key rather than as copy. Both shipped locales must carry every
		// key it can return, plus the interpolated failure message.
		for (const messages of [en, de]) {
			const group = (
				messages as unknown as {
					projects: {
						documents: { regenerateToast: Record<string, string> };
					};
				}
			).projects.documents.regenerateToast;
			for (const key of [
				"started",
				"alreadyQueued",
				"alreadyRunning",
				"failed",
			]) {
				expect(group[key]).toBeTruthy();
			}
			expect(group.failed).toContain("{message}");
		}
	});
});

/**
 * The editor's Regenerate control (toolbar button and its overflow-menu twin)
 * is disabled on this predicate. `DocumentEditor` itself cannot be mounted in
 * jsdom — it pulls in TipTap and CopilotKit — so the seam it is gated on is
 * what gets pinned here.
 */
describe("editor regenerate gate", () => {
	it("is closed while a run is queued or generating", () => {
		expect(isDocumentGenerationRunning("QUEUED")).toBe(true);
		expect(isDocumentGenerationRunning("GENERATING")).toBe(true);
	});

	it("is open once the document has settled", () => {
		for (const status of [
			"DRAFT",
			"IN_PROGRESS",
			"REVIEW",
			"COMPLETE",
			"FAILED",
		]) {
			expect(isDocumentGenerationRunning(status)).toBe(false);
		}
	});
});
