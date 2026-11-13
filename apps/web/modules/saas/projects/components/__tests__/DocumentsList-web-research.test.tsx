/**
 * The "Allow web research" option in the Documents tab's regenerate dialog.
 *
 * Pinned here: the option opens unticked every time, whichever document the
 * dialog is for and whatever the last dialog was left at; a tick reaches the
 * request as `allowWebResearch: true` only while research is available; an
 * unticked or unavailable option, the dialog having offered it, sends
 * `allowWebResearch: false`; when the organization cannot research, the
 * option is `aria-disabled` and says why; availability is asked only while
 * the dialog is open; following the settings link closes the dialog; a ticked
 * request that joins a live run started with other settings is told web
 * research was not added, while an identical or unticked one keeps the plain
 * "already running" sentence.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
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

const { documentsListMock, generateMock, availabilityMock } = vi.hoisted(
	() => ({
		documentsListMock: vi.fn(),
		generateMock: vi.fn(),
		availabilityMock: vi.fn(),
	}),
);

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
					setActive: mutation(),
					update: mutation(),
					webResearchAvailability: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: [
								"projects.documents.webResearchAvailability",
								input,
							],
							queryFn: () => availabilityMock(input),
						}),
					},
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
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

// jsdom cannot navigate; the link only has to run its click handler.
vi.mock("next/link", () => ({
	default: ({
		href,
		onClick,
		children,
		...rest
	}: {
		href: string;
		onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
		children: ReactNode;
	}) => (
		<a
			href={href}
			{...rest}
			onClick={(event) => {
				event.preventDefault();
				onClick?.(event);
			}}
		>
			{children}
		</a>
	),
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

// ── Helpers ────────────────────────────────────────────────────

const COPY = en.projects.documents.webResearch;
const TOAST = en.projects.documents.regenerateToast;

function makeDocument(overrides: Record<string, unknown> = {}) {
	return {
		id: "doc_1",
		title: "Example business case",
		type: "BUSINESS_CASE",
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

const FIRST = makeDocument();
const SECOND = makeDocument({
	id: "doc_2",
	title: "Example technical design",
	type: "TECHNICAL_DESIGN",
});

async function renderList(documents = [FIRST, SECOND]) {
	documentsListMock.mockResolvedValue({
		documents,
		total: documents.length,
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
	for (const document of documents) {
		await screen.findByText(document.title);
	}
	return client;
}

/** The Regenerate button on the card that opens `title`. */
function regenerateButtonFor(title: string): HTMLElement {
	const card = screen.getByRole("button", {
		name: `Open ${title}`,
	}).parentElement;
	if (!card) {
		throw new Error(`no card for ${title}`);
	}
	return within(card).getByRole("button", { name: "Regenerate" });
}

async function openRegenerate(
	user: ReturnType<typeof userEvent.setup>,
	title: string,
) {
	await user.click(regenerateButtonFor(title));
	return screen.findByRole("dialog");
}

function optionIn(dialog: HTMLElement): HTMLElement {
	return within(dialog).getByRole("checkbox", { name: COPY.label });
}

/** Waits until the option reflects the server's "available" answer. */
async function availableOptionIn(dialog: HTMLElement): Promise<HTMLElement> {
	await waitFor(() =>
		expect(optionIn(dialog)).not.toHaveAttribute("aria-disabled"),
	);
	return optionIn(dialog);
}

async function confirm(
	user: ReturnType<typeof userEvent.setup>,
	dialog: HTMLElement,
) {
	await user.click(
		within(dialog).getByRole("button", { name: "Regenerate" }),
	);
	await waitFor(() => expect(generateMock).toHaveBeenCalled());
}

function lastRequest(): unknown {
	return generateMock.mock.calls.at(-1)?.[0];
}

// ── Tests ──────────────────────────────────────────────────────

describe("DocumentsList — web research in the regenerate dialog", () => {
	beforeEach(() => {
		documentsListMock.mockReset();
		generateMock.mockReset();
		generateMock.mockResolvedValue({ outcome: "started" });
		availabilityMock.mockReset();
		availabilityMock.mockResolvedValue({ available: true, missing: [] });
		vi.mocked(toast.success).mockClear();
		vi.mocked(toast.warning).mockClear();
	});

	it("asks whether research is available only once the dialog opens, for this project", async () => {
		const user = userEvent.setup();
		await renderList();

		expect(availabilityMock).not.toHaveBeenCalled();

		await openRegenerate(user, FIRST.title);

		await waitFor(() =>
			expect(availabilityMock).toHaveBeenCalledWith({
				projectId: "proj_1",
			}),
		);
	});

	it("opens with the option unticked", async () => {
		const user = userEvent.setup();
		await renderList();

		const dialog = await openRegenerate(user, FIRST.title);

		const option = await availableOptionIn(dialog);
		expect(option).toHaveAttribute("aria-checked", "false");
	});

	it("sends allowWebResearch: true when ticked and confirmed", async () => {
		const user = userEvent.setup();
		await renderList();

		const dialog = await openRegenerate(user, FIRST.title);
		await user.click(await availableOptionIn(dialog));
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "true");
		await confirm(user, dialog);

		expect(lastRequest()).toStrictEqual({
			id: FIRST.id,
			allowWebResearch: true,
		});
	});

	it("sends allowWebResearch: false when confirmed unticked", async () => {
		const user = userEvent.setup();
		await renderList();

		const dialog = await openRegenerate(user, FIRST.title);
		await availableOptionIn(dialog);
		await confirm(user, dialog);

		expect(lastRequest()).toStrictEqual({
			id: FIRST.id,
			allowWebResearch: false,
		});
	});

	it("sends allowWebResearch: false for a tick that availability has since withdrawn", async () => {
		const user = userEvent.setup();
		const client = await renderList();

		const dialog = await openRegenerate(user, FIRST.title);
		await user.click(await availableOptionIn(dialog));
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "true");

		// The organization loses its search provider while the dialog is open.
		act(() => {
			client.setQueryData(
				[
					"projects.documents.webResearchAvailability",
					{ projectId: "proj_1" },
				],
				{ available: false, missing: ["search"] },
			);
		});
		await waitFor(() =>
			expect(optionIn(dialog)).toHaveAttribute("aria-disabled", "true"),
		);
		await confirm(user, dialog);

		expect(lastRequest()).toStrictEqual({
			id: FIRST.id,
			allowWebResearch: false,
		});
	});

	it("opens unticked for the next document after a ticked regenerate", async () => {
		const user = userEvent.setup();
		await renderList();

		const first = await openRegenerate(user, FIRST.title);
		await user.click(await availableOptionIn(first));
		await confirm(user, first);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		const second = await openRegenerate(user, SECOND.title);
		const option = await availableOptionIn(second);
		expect(option).toHaveAttribute("aria-checked", "false");
		await confirm(user, second);

		expect(lastRequest()).toStrictEqual({
			id: SECOND.id,
			allowWebResearch: false,
		});
	});

	it("opens unticked again after a ticked dialog is cancelled", async () => {
		const user = userEvent.setup();
		await renderList();

		const first = await openRegenerate(user, FIRST.title);
		await user.click(await availableOptionIn(first));
		await user.click(within(first).getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		const again = await openRegenerate(user, FIRST.title);
		const option = await availableOptionIn(again);
		expect(option).toHaveAttribute("aria-checked", "false");
		expect(generateMock).not.toHaveBeenCalled();
	});

	it("is aria-disabled with the reason when the organization cannot research, and sends allowWebResearch: false", async () => {
		availabilityMock.mockResolvedValue({
			available: false,
			missing: ["search"],
		});
		const user = userEvent.setup();
		await renderList();

		const dialog = await openRegenerate(user, FIRST.title);
		const reason = await within(dialog).findByText(COPY.missingSearch, {
			exact: false,
		});
		const option = optionIn(dialog);
		expect(option).toHaveAttribute("aria-disabled", "true");
		expect(option).not.toBeDisabled();
		const describedBy = option.getAttribute("aria-describedby") ?? "";
		expect(describedBy.split(" ")).toContain(reason.id);

		await user.click(option);
		expect(option).toHaveAttribute("aria-checked", "false");
		await confirm(user, dialog);

		expect(lastRequest()).toStrictEqual({
			id: FIRST.id,
			allowWebResearch: false,
		});
	});

	it("closes the dialog when the settings link is followed", async () => {
		availabilityMock.mockResolvedValue({
			available: false,
			missing: ["search", "read"],
		});
		const user = userEvent.setup();
		await renderList();

		const dialog = await openRegenerate(user, FIRST.title);
		await user.click(
			await within(dialog).findByRole("link", {
				name: COPY.settingsLink,
			}),
		);

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(generateMock).not.toHaveBeenCalled();
	});
	describe("when the request joins a run already under way", () => {
		async function regenerate(tick: boolean) {
			const user = userEvent.setup();
			await renderList();
			const dialog = await openRegenerate(user, FIRST.title);
			const option = await availableOptionIn(dialog);
			if (tick) {
				await user.click(option);
			}
			await confirm(user, dialog);
		}

		it("warns that ticked web research was not added to a run started with other settings", async () => {
			generateMock.mockResolvedValue({
				outcome: "alreadyInProgress",
				sameRequest: false,
			});

			await regenerate(true);

			await waitFor(() =>
				expect(toast.warning).toHaveBeenCalledWith(
					TOAST.alreadyRunningResearchNotApplied,
				),
			);
			expect(toast.success).not.toHaveBeenCalled();
		});

		it("keeps the plain sentence when the joined run is the identical request", async () => {
			generateMock.mockResolvedValue({
				outcome: "alreadyInProgress",
				sameRequest: true,
			});

			await regenerate(true);

			await waitFor(() =>
				expect(toast.success).toHaveBeenCalledWith(
					TOAST.alreadyRunning,
				),
			);
			expect(toast.warning).not.toHaveBeenCalled();
		});

		it("keeps the plain sentence when research was not ticked", async () => {
			generateMock.mockResolvedValue({
				outcome: "alreadyInProgress",
				sameRequest: false,
			});

			await regenerate(false);

			await waitFor(() =>
				expect(toast.success).toHaveBeenCalledWith(
					TOAST.alreadyRunning,
				),
			);
			expect(toast.warning).not.toHaveBeenCalled();
		});
	});
});
