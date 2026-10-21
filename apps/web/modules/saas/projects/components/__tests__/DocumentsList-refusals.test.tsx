/**
 * What the Documents tab says when the server refuses a regenerate or a
 * switch of the active document (Fizzy #2946).
 *
 * A Proposal regenerated while nothing is bound to Client proposal (Main),
 * or through an action the Proposal artifact supersedes, is refused with a
 * code; the list says so in the reader's words with the link that resolves
 * it, like every other place a generation starts. Any other regenerate
 * failure keeps the list's own message. Switching the active document says
 * what happened in the reader's locale, never the server's words.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../../../../../packages/i18n/translations/en.json";

// ── jsdom polyfills ────────────────────────────────────────────
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

// ── Module mocks ───────────────────────────────────────────────

const { documentsListMock, generateMock, setActiveMock, routerPush } =
	vi.hoisted(() => ({
		documentsListMock: vi.fn(),
		generateMock: vi.fn(),
		setActiveMock: vi.fn(),
		routerPush: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = (mutationFn?: (input: unknown) => unknown) => ({
		mutationOptions: (opts: unknown) => ({
			...(opts ?? {}),
			...(mutationFn ? { mutationFn } : {}),
		}),
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
					generate: mutation((input) => generateMock(input)),
					setActive: mutation((input) => setActiveMock(input)),
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
	useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
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

import { toast } from "sonner";
import { DocumentsList } from "../DocumentsList";
import { proposalMainCatalogHref } from "../proposal-artifact/generation-feedback";

// ── Helpers ────────────────────────────────────────────────────

const FEEDBACK = en.projects.proposalArtifact.generationFeedback;
const SET_ACTIVE = en.projects.documents.setActive;

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Example proposal",
		type: "PROPOSAL",
		status: "COMPLETE",
		source: "GENERATED",
		isActive: true,
		version: 2,
		wordCount: 420,
		content: "# Scope\n\nThe saved body.",
		generationProgress: 100,
		generationError: null,
		generationQueueReason: null,
		generationStartedAt: null,
		updatedAt: new Date("2026-09-07T10:00:00Z"),
		createdAt: new Date("2026-09-07T10:00:00Z"),
		_count: { versions: 1 },
		...overrides,
	};
}

async function renderWithDocument(document: Record<string, unknown>) {
	documentsListMock.mockResolvedValue({
		documents: [document],
		total: 1,
		hasMore: false,
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<DocumentsList projectId="proj_1" enableDelete />
		</QueryClientProvider>,
	);
	await screen.findByText(String(document.title));
}

/** A refusal shaped like the client's thrown oRPC error. */
function refusal(code: string, dataCode?: string, message = "server words") {
	return Object.assign(new Error(message), {
		code,
		...(dataCode ? { data: { code: dataCode } } : {}),
	});
}

async function regenerate() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Regenerate" }));
	const dialog = await screen.findByRole("dialog");
	await user.click(
		within(dialog).getByRole("button", { name: "Regenerate" }),
	);
}

// ── Tests ──────────────────────────────────────────────────────

describe("DocumentsList — a refused regenerate", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		generateMock.mockReset();
		routerPush.mockReset();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.success).mockClear();
	});

	it.each([
		["PRECONDITION_FAILED", "PROPOSAL_PROMPT_NOT_BOUND", "promptNotBound"],
		["BAD_REQUEST", "PROPOSAL_ACTION_SUPERSEDED", "actionSuperseded"],
	] as const)(
		"says a %s %s refusal in the reader's words, with the catalog link",
		async (code, dataCode, kind) => {
			generateMock.mockRejectedValue(
				refusal(code, dataCode, "Bind a prompt first (server English)"),
			);
			await renderWithDocument(makeDocument());

			await regenerate();

			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledTimes(1);
			});
			const [message, options] = vi.mocked(toast.error).mock.calls[0] as [
				string,
				{ action: { label: string; onClick: () => void } },
			];
			expect(message).toBe(FEEDBACK[kind]);
			expect(message).not.toContain("server English");
			expect(options.action.label).toBe(FEEDBACK.openCatalog);
			options.action.onClick();
			expect(routerPush).toHaveBeenCalledWith(
				proposalMainCatalogHref("/app/example-org"),
			);
		},
	);

	it("keeps the list's own message for any other failure", async () => {
		generateMock.mockRejectedValue(
			refusal("INTERNAL_SERVER_ERROR", undefined, "Temporal unavailable"),
		);
		await renderWithDocument(makeDocument());

		await regenerate();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				en.projects.documents.regenerateToast.failed.replace(
					"{message}",
					"Temporal unavailable",
				),
			);
		});
	});
});

describe("DocumentsList — switching the active document", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		setActiveMock.mockReset();
		vi.mocked(toast.error).mockClear();
		vi.mocked(toast.success).mockClear();
	});

	it("says it in the reader's locale", async () => {
		setActiveMock.mockResolvedValue({ success: true });
		const user = userEvent.setup();
		await renderWithDocument(makeDocument({ isActive: false }));

		await user.click(screen.getByRole("button", { name: "Set as active" }));

		await waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith(SET_ACTIVE.updated);
		});
	});

	it("says a failure in the reader's words, never the server's", async () => {
		setActiveMock.mockRejectedValue(
			refusal("FORBIDDEN", undefined, "You don't have access"),
		);
		const user = userEvent.setup();
		await renderWithDocument(makeDocument({ isActive: false }));

		await user.click(screen.getByRole("button", { name: "Set as active" }));

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(SET_ACTIVE.failed);
		});
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("You don't have access"),
		);
	});
});
