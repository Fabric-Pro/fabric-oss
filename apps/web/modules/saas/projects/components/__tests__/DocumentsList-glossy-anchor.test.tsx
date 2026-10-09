/**
 * The Documents tab's Get Started anchor for Glossy editions (Fizzy #2589).
 *
 * The Documents page tour and the guided tour both spotlight
 * `data-onboarding-target="documents-glossy"`. The anchor must exist exactly
 * where a Glossy entry point does — a card whose Download menu offers the
 * Glossy item — and nowhere else: with the `GLOSSY_EDITION` gate off, on a
 * type that is not a Proposal or Business Case, or on a card with no content
 * (no Download menu), a tour step would otherwise point at a feature the
 * viewer cannot reach.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { documentsListMock, glossyGetMock, flags } = vi.hoisted(() => ({
	documentsListMock: vi.fn(),
	glossyGetMock: vi.fn(),
	flags: { glossyEdition: false, proposalArtifact: false },
}));

// The legacy-edition read a Proposal makes under the Proposal artifact gate.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			glossy: { get: (input: unknown) => glossyGetMock(input) },
		},
	},
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
	useFeatureFlag: (key: string) =>
		key === "GLOSSY_EDITION"
			? flags.glossyEdition
			: key === "PROPOSAL_ARTIFACT"
				? flags.proposalArtifact
				: false,
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

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Example proposal",
		type: "PROPOSAL",
		status: "COMPLETE",
		source: "GENERATED",
		isActive: true,
		wordCount: 120,
		content: "# Example proposal",
		generationProgress: 100,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: new Date("2026-09-07T10:00:00Z"),
		updatedAt: new Date("2026-09-07T10:00:00Z"),
		createdAt: new Date("2026-09-07T10:00:00Z"),
		_count: { versions: 0 },
		...overrides,
	};
}

async function renderWithDocuments(documents: Record<string, unknown>[]) {
	documentsListMock.mockResolvedValue({
		documents,
		total: documents.length,
		hasMore: false,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<DocumentsList projectId="proj_1" enableDelete />
		</QueryClientProvider>,
	);
	await screen.findByText(String(documents[0].title));
	return view;
}

const glossyAnchors = (container: HTMLElement) =>
	container.querySelectorAll('[data-onboarding-target="documents-glossy"]');

// ── Tests ────────────────────────────────────────────────────────────────

describe("DocumentsList — Glossy edition tour anchor", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		flags.glossyEdition = false;
		flags.proposalArtifact = false;
	});

	it("marks each Proposal and Business Case card with the gate on", async () => {
		flags.glossyEdition = true;
		const { container } = await renderWithDocuments([
			makeDocument(),
			makeDocument({
				id: "doc_2",
				title: "Example business case",
				type: "BUSINESS_CASE",
			}),
			makeDocument({
				id: "doc_3",
				title: "Example architecture",
				type: "ARCHITECTURE",
			}),
		]);

		const anchors = glossyAnchors(container);
		expect(anchors).toHaveLength(2);
		for (const anchor of anchors) {
			// A marker the spotlight measures, never something to reach:
			// hidden from assistive technology and transparent to clicks,
			// so the card's own open button still takes the press.
			expect(anchor).toHaveAttribute("aria-hidden", "true");
			expect(anchor).toHaveClass("pointer-events-none");
			expect(anchor.textContent).toBe("");
		}
	});

	it("places no anchor with the gate off", async () => {
		const { container } = await renderWithDocuments([makeDocument()]);

		expect(glossyAnchors(container)).toHaveLength(0);
	});

	it("places no anchor on a type that has no Glossy edition", async () => {
		flags.glossyEdition = true;
		const { container } = await renderWithDocuments([
			makeDocument({ title: "Example PRD", type: "PRD" }),
		]);

		expect(glossyAnchors(container)).toHaveLength(0);
	});

	it("places no anchor on a card with no content, which has no Download menu", async () => {
		flags.glossyEdition = true;
		const { container } = await renderWithDocuments([
			makeDocument({ status: "FAILED", wordCount: 0, content: "" }),
		]);

		expect(glossyAnchors(container)).toHaveLength(0);
	});
});

/**
 * Under the `PROPOSAL_ARTIFACT` rollout gate (Fizzy #2801) a Proposal is
 * written client-ready and needs no Glossy edition, so its card carries the
 * anchor only when a legacy edition was published — the same rule its
 * Download menu follows, so the tour never spotlights a card whose menu has
 * no Glossy item. A Business Case is untouched.
 */
describe("DocumentsList — Glossy anchor under the Proposal artifact gate", () => {
	/** The anchor on the Proposal's own card, if it carries one. */
	const proposalAnchor = () =>
		screen
			.getByRole("button", { name: "Open Example proposal" })
			.parentElement?.querySelector(
				'[data-onboarding-target="documents-glossy"]',
			) ?? null;
	/** Let a settled read reach the list before asserting an absence. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const edition = (content: unknown) => ({
		edition: { content },
		build: { status: "idle" },
	});

	beforeEach(() => {
		documentsListMock.mockReset();
		glossyGetMock.mockReset();
		flags.glossyEdition = true;
		flags.proposalArtifact = true;
	});

	it("drops it from a Proposal without an edition and keeps it on a Business Case", async () => {
		glossyGetMock.mockResolvedValue({
			edition: null,
			build: { status: "idle" },
		});
		const { container } = await renderWithDocuments([
			makeDocument(),
			makeDocument({
				id: "doc_2",
				title: "Example business case",
				type: "BUSINESS_CASE",
			}),
		]);

		await waitFor(() => expect(glossyGetMock).toHaveBeenCalled());
		await settle();
		// Only the Proposal is asked about; a Business Case needs no answer.
		expect(glossyGetMock).toHaveBeenCalledTimes(1);
		expect(glossyGetMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			documentId: "doc_1",
		});
		expect(glossyAnchors(container)).toHaveLength(1);
		expect(proposalAnchor()).toBeNull();
	});

	it("keeps it on a Proposal whose legacy edition was published", async () => {
		glossyGetMock.mockResolvedValue(edition({ sections: [] }));
		const { container } = await renderWithDocuments([makeDocument()]);

		await waitFor(() => expect(proposalAnchor()).not.toBeNull());
		expect(glossyAnchors(container)).toHaveLength(1);
	});

	it("drops it from a Proposal whose edition never finished a build", async () => {
		// An edition row with no published content has nothing to open.
		glossyGetMock.mockResolvedValue(edition(null));
		const { container } = await renderWithDocuments([makeDocument()]);

		await waitFor(() => expect(glossyGetMock).toHaveBeenCalled());
		await settle();
		expect(glossyAnchors(container)).toHaveLength(0);
	});

	it("drops it when the edition read is refused, without retrying", async () => {
		glossyGetMock.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);
		const { container } = await renderWithDocuments([makeDocument()]);

		await waitFor(() => expect(glossyGetMock).toHaveBeenCalledTimes(1));
		await settle();
		expect(glossyAnchors(container)).toHaveLength(0);
		expect(glossyGetMock).toHaveBeenCalledTimes(1);
	});

	it("reads no edition and places no anchor with the Glossy gate off", async () => {
		flags.glossyEdition = false;
		const { container } = await renderWithDocuments([makeDocument()]);

		expect(glossyAnchors(container)).toHaveLength(0);
		expect(glossyGetMock).not.toHaveBeenCalled();
	});

	it("reads no edition with the artifact gate off, where a Proposal keeps its anchor", async () => {
		flags.proposalArtifact = false;
		const { container } = await renderWithDocuments([makeDocument()]);

		expect(glossyAnchors(container)).toHaveLength(1);
		expect(glossyGetMock).not.toHaveBeenCalled();
	});
});
