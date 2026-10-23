/**
 * Fizzy #2946 — the Documents tab's version number after a run.
 *
 * A run saves its final body at the version it started from and steps the
 * version in a later write that sends no nudge, and the list stops polling at
 * the run's COMPLETE. So for a while after a run it saw under way ends, the
 * list asks again until the card carries the stepped version.
 */

import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
					update: mutation(),
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

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

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

import { DocumentsList } from "../DocumentsList";

// ── Helpers ──────────────────────────────────────────────────────────────

const LIST_KEY: QueryKey = [
	"projects.documents.list",
	{ projectId: "proj_1", organizationId: "org_1" },
];

function listOf(overrides: Record<string, unknown>) {
	const document = {
		id: "doc_1",
		title: "Architecture Overview",
		type: "ARCHITECTURE",
		status: "COMPLETE",
		source: "GENERATED",
		isActive: true,
		version: 2,
		wordCount: 120,
		content: "",
		generationProgress: 0,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: new Date(),
		updatedAt: new Date(),
		createdAt: new Date(),
		_count: { versions: 1 },
		...overrides,
	};
	return { documents: [document], total: 1, hasMore: false };
}

let client: QueryClient;

/** Renders the list on this answer, with the clock faked from the start. */
async function renderOn(overrides: Record<string, unknown>) {
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	});
	documentsListMock.mockResolvedValue(listOf(overrides));
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<DocumentsList projectId="proj_1" enableDelete />
		</QueryClientProvider>,
	);
	await wait(0);
}

/** The server answers this from now on, and the list hears it at once. */
async function serverAnswers(overrides: Record<string, unknown>) {
	documentsListMock.mockResolvedValue(listOf(overrides));
	await act(async () => {
		client.setQueryData(LIST_KEY, listOf(overrides));
		await vi.advanceTimersByTimeAsync(0);
	});
}

async function wait(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

const reads = () => documentsListMock.mock.calls.length;

// ── Tests ────────────────────────────────────────────────────────────────

describe("DocumentsList — the version step after a run", () => {
	afterEach(() => {
		vi.useRealTimers();
		documentsListMock.mockReset();
	});

	it("asks again after a run ends and shows the stepped version once it arrives", async () => {
		await renderOn({ status: "GENERATING", version: 2 });
		expect(screen.getByText("v2")).toBeInTheDocument();

		await serverAnswers({ status: "COMPLETE", version: 2 });
		const before = reads();

		await wait(3000);
		expect(reads()).toBe(before + 1);
		documentsListMock.mockResolvedValue(
			listOf({ status: "COMPLETE", version: 3 }),
		);
		await wait(6000);
		expect(reads()).toBe(before + 2);

		await wait(30_000);
		expect(reads()).toBe(before + 2);
		expect(screen.getByText("v3")).toBeInTheDocument();
	});
});
