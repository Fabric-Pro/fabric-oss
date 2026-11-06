/**
 * Progress and in-flight state for a Context row's download.
 *
 * PDF and Word are built in the browser from the row's extracted text, which
 * takes seconds on a long transcript. The row now says so: a toast naming the
 * file opens the moment the format is chosen, stays until the file is handed
 * to the browser, and is replaced in place by the failure message if any step
 * fails. The menu closes on select, and while a row's download runs its
 * download items are disabled and read "preparing", so a second copy cannot
 * start. Markdown and original-file downloads are a plain signed-URL save:
 * they get the guard and the disabled state, but no toast.
 *
 * Every slow step is a deferred promise the test releases by hand, so each
 * assertion runs at a known point of the download.
 *
 * Copy keys render raw. The translator mock below appends interpolated values
 * after the key (`preparingPdf · Kickoff notes`), so a test can see which file
 * a message names.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { buildCapabilityGateView } from "../../lib/capability-gate-view";

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
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	contextsListMock,
	createDownloadUrlMock,
	renderMarkdownToPdfMock,
	renderMarkdownToDocxMock,
	triggerBlobDownloadMock,
	triggerUrlDownloadMock,
	refetchGatesMock,
	gateRef,
	trackEventMock,
	toastMock,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	createDownloadUrlMock: vi.fn(),
	renderMarkdownToPdfMock: vi.fn(),
	renderMarkdownToDocxMock: vi.fn(),
	triggerBlobDownloadMock: vi.fn(),
	triggerUrlDownloadMock: vi.fn(),
	refetchGatesMock: vi.fn(),
	gateRef: { current: null as CapabilityGate | null },
	trackEventMock: vi.fn(),
	toastMock: {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
		dismiss: vi.fn(),
	},
}));

// The global setup's translator drops interpolated values; this one keeps
// them, so the toast's file name is visible to the assertions.
vi.mock("next-intl", () => {
	const translator = () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values
				? [key, ...Object.values(values).map(String)].join(" · ")
				: key;
		t.raw = (key: string) => key;
		t.has = (_key: string) => false;
		return t;
	};
	return {
		useTranslations: translator,
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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: {} } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({
						input,
						refetchInterval,
					}: {
						input: unknown;
						refetchInterval?: unknown;
					}) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: () => contextsListMock(input),
						refetchInterval,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
				delete: { call: vi.fn() },
				createDownloadUrl: { call: createDownloadUrlMock },
				retryStalled: { call: vi.fn() },
				repositorySync: {
					get: {
						queryOptions: () => ({
							queryKey: [
								"projects.contexts.repositorySync.get",
							] as const,
							queryFn: async () => null,
						}),
					},
					configure: { mutationOptions: () => ({}) },
					syncNow: { mutationOptions: () => ({}) },
					disable: { mutationOptions: () => ({}) },
				},
			},
		},
		integrations: {
			teams: {
				contextAccess: {
					queryOptions: () => ({
						queryKey: ["integrations.teams.contextAccess"] as const,
						queryFn: async () => ({
							connected: false,
							contexts: [],
						}),
					}),
				},
			},
		},
	},
}));

vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../capability-gates/useCapabilityGates")
			>();
		return {
			...actual,
			useCapabilityGate: (key: string) => {
				const gate =
					gateRef.current?.capabilityKey === key
						? gateRef.current
						: null;
				return {
					gate,
					view: gate ? buildCapabilityGateView(gate) : null,
					blocked: false,
					hidden: false,
				};
			},
			useCapabilityGates: () => ({
				projectId: "proj_1",
				enabled: true,
				isLoading: false,
				gates: new Map(),
				suppressedCount: 0,
				isSessionDismissed: () => false,
				linkFor: () => null,
				codebaseRetryFor: () => undefined,
				codebaseRetrying: false,
				suppress: () => {},
				restore: () => {},
				refetch: refetchGatesMock,
			}),
		};
	},
);

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

// jsdom has no `URL.createObjectURL`, so the save itself is a mock; the
// assertions read the blob and filename it was handed.
vi.mock("../../lib/markdown-to-document", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/markdown-to-document")>();
	return {
		...actual,
		renderMarkdownToPdf: renderMarkdownToPdfMock,
		renderMarkdownToDocx: renderMarkdownToDocxMock,
		triggerBlobDownload: triggerBlobDownloadMock,
		triggerUrlDownload: triggerUrlDownloadMock,
	};
});

vi.mock("../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../DownloadAllContextsButton", () => ({
	DownloadAllContextsButton: () => null,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: ({ aside }: { aside?: React.ReactNode }) => (
		<div>{aside}</div>
	),
}));

import { ProjectContextsList } from "../ProjectContextsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const LONG_AGO = new Date("2026-09-01T08:00:00Z");
const MARKDOWN = "# Kickoff notes\n\nAgreed scope and dates.";
const NOTE_TOAST_ID = "context-download-ctx_note";

function textContext(id: string, title: string) {
	return {
		id,
		type: "TEXT",
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: LONG_AGO,
		createdAt: LONG_AGO,
		sourceTitle: title,
		s3Path: null,
		contentLength: 120,
		metadata: { title },
	};
}

function apiSpecContext(id: string, filename: string) {
	return {
		id,
		type: "API_SPEC",
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: LONG_AGO,
		createdAt: LONG_AGO,
		sourceTitle: null,
		originalFilename: filename,
		mimeType: "application/json",
		s3Path: `projects/proj_1/${id}.json`,
		fileSize: 1691,
		contentLength: 640,
		metadata: { title: filename },
	};
}

function linkContext(id: string) {
	return {
		id,
		type: "LINK",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		extractionStatus: "COMPLETED",
		extractionError: null,
		urlScope: "PATH_PREFIX",
		urlMaxPages: 100,
		urlRefreshMode: "ONCE",
		urlLastSyncedAt: LONG_AGO,
		createdAt: LONG_AGO,
		embeddedAt: null,
		metadata: { sourceTitle: "Example Docs" },
	};
}

function signedText(filename = "kickoff-notes.md") {
	return {
		url: "https://storage.example.com/signed/kickoff-notes.md",
		filename,
		expiresAt: "2026-11-05T00:05:00.000Z",
		contextClass: "B",
	};
}

function serveContexts(contexts: unknown[]) {
	contextsListMock.mockResolvedValue({
		contexts,
		total: contexts.length,
		hasMore: false,
	});
}

/** Opens the row's "More options" menu. */
async function openRowMenu(
	user: ReturnType<typeof userEvent.setup>,
	container: HTMLElement,
	contextId: string,
): Promise<HTMLElement> {
	await waitFor(() =>
		expect(
			container.querySelector(`[data-context-id="${contextId}"]`),
		).not.toBeNull(),
	);
	const row = container.querySelector<HTMLElement>(
		`[data-context-id="${contextId}"]`,
	);
	if (!row) {
		throw new Error(`no row for ${contextId}`);
	}
	await user.click(within(row).getByRole("button", { name: "More options" }));
	return screen.findByRole("menu");
}

/** Opens the row menu, then the Download submenu, then picks a format. */
async function chooseFormat(
	user: ReturnType<typeof userEvent.setup>,
	container: HTMLElement,
	contextId: string,
	format: "format.markdown" | "format.pdf" | "format.docx",
): Promise<void> {
	await openRowMenu(user, container, contextId);
	// By keyboard: jsdom lays nothing out, so a pointer moving from the
	// sub-trigger to an item reads to Radix as leaving the submenu and closes
	// it before the click lands.
	screen.getByRole("menuitem", { name: "format.aria" }).focus();
	await user.keyboard("{ArrowRight}");
	const item = await screen.findByRole("menuitem", { name: format });
	item.focus();
	await user.keyboard("{Enter}");
}

async function expectMenuClosed(): Promise<void> {
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — download progress", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		contextsListMock.mockReset();
		createDownloadUrlMock.mockReset();
		renderMarkdownToPdfMock.mockReset();
		renderMarkdownToDocxMock.mockReset();
		triggerBlobDownloadMock.mockReset();
		triggerUrlDownloadMock.mockReset();
		trackEventMock.mockReset();
		for (const fn of Object.values(toastMock)) {
			fn.mockReset();
		}
		gateRef.current = null;

		renderMarkdownToPdfMock.mockResolvedValue(new Blob(["%PDF"]));
		renderMarkdownToDocxMock.mockResolvedValue(new Blob(["docx"]));
		fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => MARKDOWN,
		}));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("opens a toast naming the file before the download link is signed", async () => {
		const signing = deferred<ReturnType<typeof signedText>>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");

		expect(createDownloadUrlMock).toHaveBeenCalledTimes(1);
		expect(toastMock.loading).toHaveBeenCalledTimes(1);
		expect(toastMock.loading).toHaveBeenCalledWith(
			"preparingPdf · Kickoff notes",
			{ id: NOTE_TOAST_ID },
		);
		expect(toastMock.loading.mock.invocationCallOrder[0]).toBeLessThan(
			createDownloadUrlMock.mock.invocationCallOrder[0],
		);
		expect(fetchMock).not.toHaveBeenCalled();
		await expectMenuClosed();

		signing.resolve(signedText());
		await waitFor(() =>
			expect(toastMock.dismiss).toHaveBeenCalledWith(NOTE_TOAST_ID),
		);
	});

	it("keeps the toast up while the PDF renders and dismisses it once the file is saved", async () => {
		const signing = deferred<ReturnType<typeof signedText>>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		const rendering = deferred<Blob>();
		renderMarkdownToPdfMock.mockReturnValue(rendering.promise);
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		signing.resolve(signedText());

		await waitFor(() =>
			expect(renderMarkdownToPdfMock).toHaveBeenCalledWith(MARKDOWN),
		);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/signed/kickoff-notes.md",
			expect.anything(),
		);
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(toastMock.dismiss).not.toHaveBeenCalled();
		expect(triggerBlobDownloadMock).not.toHaveBeenCalled();

		const pdf = new Blob(["%PDF-1.7"]);
		rendering.resolve(pdf);

		await waitFor(() =>
			expect(toastMock.dismiss).toHaveBeenCalledWith(NOTE_TOAST_ID),
		);
		expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		expect(triggerBlobDownloadMock).toHaveBeenCalledWith(
			pdf,
			"kickoff-notes.pdf",
		);
		// The toast goes only after the file has been handed to the browser.
		expect(toastMock.dismiss.mock.invocationCallOrder[0]).toBeGreaterThan(
			triggerBlobDownloadMock.mock.invocationCallOrder[0],
		);
		expect(toastMock.error).not.toHaveBeenCalled();
		expect(trackEventMock).toHaveBeenCalledWith(
			"project_context_downloaded",
			expect.objectContaining({ contextId: "ctx_note", format: "pdf" }),
		);
	});

	it("does the same for a Word document", async () => {
		const rendering = deferred<Blob>();
		renderMarkdownToDocxMock.mockReturnValue(rendering.promise);
		createDownloadUrlMock.mockResolvedValue(signedText());
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.docx");

		expect(toastMock.loading).toHaveBeenCalledWith(
			"preparingDocx · Kickoff notes",
			{ id: NOTE_TOAST_ID },
		);
		await waitFor(() =>
			expect(renderMarkdownToDocxMock).toHaveBeenCalledWith(
				MARKDOWN,
				"Kickoff notes",
			),
		);
		expect(toastMock.dismiss).not.toHaveBeenCalled();

		const docx = new Blob(["PK"]);
		rendering.resolve(docx);

		await waitFor(() =>
			expect(toastMock.dismiss).toHaveBeenCalledWith(NOTE_TOAST_ID),
		);
		expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		expect(triggerBlobDownloadMock).toHaveBeenCalledWith(
			docx,
			"kickoff-notes.docx",
		);
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	it("replaces the toast with the failure message when the PDF cannot be built, and lets the row download again", async () => {
		const rendering = deferred<Blob>();
		renderMarkdownToPdfMock.mockReturnValue(rendering.promise);
		createDownloadUrlMock.mockResolvedValue(signedText());
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		await waitFor(() => expect(renderMarkdownToPdfMock).toHaveBeenCalled());
		rendering.reject(new Error("jsPDF ran out of memory"));

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith("failed", {
				id: NOTE_TOAST_ID,
			}),
		);
		expect(toastMock.error).toHaveBeenCalledTimes(1);
		// Same id as the loading toast: Sonner swaps it in place, so no
		// spinner is left behind beside the error.
		expect(toastMock.loading).toHaveBeenCalledWith(expect.any(String), {
			id: NOTE_TOAST_ID,
		});
		expect(toastMock.dismiss).not.toHaveBeenCalled();
		expect(triggerBlobDownloadMock).not.toHaveBeenCalled();
		expect(trackEventMock).not.toHaveBeenCalledWith(
			"project_context_downloaded",
			expect.anything(),
		);

		await openRowMenu(user, container, "ctx_note");
		const trigger = screen.getByRole("menuitem", { name: "format.aria" });
		expect(trigger).not.toHaveAttribute("data-disabled");
		expect(
			screen.queryByRole("menuitem", { name: "preparingFile" }),
		).not.toBeInTheDocument();
	});

	it("shows the failure in the same toast when the download link cannot be signed, and clears the row", async () => {
		const signing = deferred<ReturnType<typeof signedText>>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		signing.reject(new Error("FORBIDDEN"));

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith("failed", {
				id: NOTE_TOAST_ID,
			}),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();

		await openRowMenu(user, container, "ctx_note");
		expect(
			screen.getByRole("menuitem", { name: "format.aria" }),
		).not.toHaveAttribute("data-disabled");
	});

	it("ends in the failure toast when the stored text does not arrive in time", async () => {
		// Stand-in for the 60-second timer: the component asks for a timeout
		// signal, the test hands it one it can abort, and the fetch stub
		// rejects the way `fetch` does when its signal fires.
		const timer = new AbortController();
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(timer.signal);
		fetchMock.mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		createDownloadUrlMock.mockResolvedValue(signedText());
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(timeoutSpy).toHaveBeenCalledWith(60_000);
		expect(toastMock.error).not.toHaveBeenCalled();

		timer.abort(
			new DOMException("The operation timed out.", "TimeoutError"),
		);

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith("failed", {
				id: NOTE_TOAST_ID,
			}),
		);
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(toastMock.dismiss).not.toHaveBeenCalled();
	});

	it("ends in the failure toast and frees the row when signing never answers", async () => {
		// The same deadline covers the signing request: a stub that only ever
		// settles when its signal fires stands in for a request with no reply.
		const timer = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
		createDownloadUrlMock.mockImplementation(
			(_input: unknown, options?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					);
				}),
		);
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		await waitFor(() =>
			expect(createDownloadUrlMock).toHaveBeenCalledTimes(1),
		);
		expect(toastMock.error).not.toHaveBeenCalled();

		timer.abort(
			new DOMException("The operation timed out.", "TimeoutError"),
		);

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith("failed", {
				id: NOTE_TOAST_ID,
			}),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		await openRowMenu(user, container, "ctx_note");
		expect(
			screen.getByRole("menuitem", { name: "format.aria" }),
		).not.toHaveAttribute("data-disabled");
	});

	it("disables only the downloading row's Download and labels it as preparing", async () => {
		const signing = deferred<ReturnType<typeof signedText>>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		serveContexts([
			textContext("ctx_note", "Kickoff notes"),
			textContext("ctx_other", "Retro notes"),
		]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.pdf");
		await expectMenuClosed();

		// A second select on this row cannot be driven through the menu: its
		// Download is disabled, which is what this asserts. The handler's own
		// guard is covered by the link-row test below, whose item stays live.
		await openRowMenu(user, container, "ctx_note");
		const preparing = screen.getByRole("menuitem", {
			name: "preparingFile",
		});
		expect(preparing).toHaveAttribute("data-disabled");
		expect(preparing).toHaveAttribute("aria-disabled", "true");
		expect(preparing).toHaveTextContent("preparingFile");
		const spinner = preparing.querySelector(
			"svg.motion-safe\\:animate-spin",
		);
		expect(spinner).not.toBeNull();
		expect(spinner).toHaveAttribute("aria-hidden", "true");
		expect(
			screen.queryByRole("menuitem", { name: "format.aria" }),
		).not.toBeInTheDocument();
		await user.keyboard("{Escape}");
		await expectMenuClosed();

		await openRowMenu(user, container, "ctx_other");
		expect(
			screen.getByRole("menuitem", { name: "format.aria" }),
		).not.toHaveAttribute("data-disabled");
		await user.keyboard("{Escape}");

		signing.resolve(signedText());
		await waitFor(() =>
			expect(toastMock.dismiss).toHaveBeenCalledWith(NOTE_TOAST_ID),
		);
		expect(createDownloadUrlMock).toHaveBeenCalledTimes(1);
	});

	it("ignores a second download of a row that is already downloading", async () => {
		const signing = deferred<ReturnType<typeof signedText>>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		serveContexts([linkContext("ctx_link")]);
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_link");
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-download"));
		await expectMenuClosed();
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-download"));

		expect(createDownloadUrlMock).toHaveBeenCalledTimes(1);
		expect(toastMock.loading).not.toHaveBeenCalled();

		signing.resolve({
			...signedText("example-docs.md"),
			url: "https://storage.example.com/signed/example-docs.md",
		});
		await waitFor(() =>
			expect(triggerUrlDownloadMock).toHaveBeenCalledTimes(1),
		);
	});

	it("saves an original file without a toast, guarding the row while it runs", async () => {
		const signing = deferred<{
			url: string;
			filename: string;
			expiresAt: string;
			contextClass: string;
		}>();
		createDownloadUrlMock.mockReturnValue(signing.promise);
		serveContexts([apiSpecContext("ctx_spec", "petstore.json")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		const menu = await openRowMenu(user, container, "ctx_spec");
		expect(
			within(menu).queryByRole("menuitem", { name: "format.aria" }),
		).not.toBeInTheDocument();
		await user.click(
			within(menu).getByRole("menuitem", {
				name: "actionForRow · petstore.json",
			}),
		);
		await expectMenuClosed();

		await openRowMenu(user, container, "ctx_spec");
		const preparing = screen.getByRole("menuitem", {
			name: "preparingFile",
		});
		expect(preparing).toHaveAttribute("data-disabled");
		await user.keyboard("{Escape}");

		signing.resolve({
			url: "https://storage.example.com/signed/petstore.json",
			filename: "petstore.json",
			expiresAt: "2026-11-05T00:05:00.000Z",
			contextClass: "A",
		});
		await waitFor(() =>
			expect(triggerUrlDownloadMock).toHaveBeenCalledWith(
				"https://storage.example.com/signed/petstore.json",
				"petstore.json",
			),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(toastMock.loading).not.toHaveBeenCalled();
		expect(toastMock.dismiss).not.toHaveBeenCalled();
	});

	it("saves Markdown of extracted text without a toast", async () => {
		createDownloadUrlMock.mockResolvedValue(signedText());
		serveContexts([textContext("ctx_note", "Kickoff notes")]);
		const user = userEvent.setup();
		const { container } = wrap(<ProjectContextsList projectId="proj_1" />);

		await chooseFormat(user, container, "ctx_note", "format.markdown");

		await waitFor(() =>
			expect(triggerUrlDownloadMock).toHaveBeenCalledWith(
				"https://storage.example.com/signed/kickoff-notes.md",
				"kickoff-notes.md",
			),
		);
		await expectMenuClosed();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(toastMock.loading).not.toHaveBeenCalled();
		expect(toastMock.dismiss).not.toHaveBeenCalled();
		expect(toastMock.error).not.toHaveBeenCalled();
	});
});
