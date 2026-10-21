/**
 * Hook tests for `useUrlSourceForm` that don't belong to either owner's own
 * suite: the bulk auto-close timer's lifetime tied to `open`, list
 * invalidation on a mixed bulk result, and what the search-provider
 * pre-flight tells the viewer (Fizzy #3068). All are owner-agnostic — the
 * hook is driven here through the same shared tab body + footer the owners
 * render, following the harness in `submit-adapter.test.tsx`. The table for
 * `describeUnusableProviders`, which decides what that notice names, sits
 * here too.
 */
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

const { getOrgProvidersMock } = vi.hoisted(() => ({
	getOrgProvidersMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		searchProviders: {
			getOrganizationProviders: (input: unknown) =>
				getOrgProvidersMock(input),
			getUserProviders: vi.fn(),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { ContextSourceSubmitFooter } from "../components/ContextSourceSubmitFooter";
import { UrlSourceTabContent } from "../components/UrlSourceTabContent";
import { useFileSourceForm } from "../hooks/use-file-source-form";
import { useTextSourceForm } from "../hooks/use-text-source-form";
import { useUrlSourceForm } from "../hooks/use-url-source-form";
import type { ContextSourceSubmitAdapter } from "../lib/submit-adapter";
import { describeUnusableProviders } from "../lib/url-source";

const LIST_KEY = ["stub-owner", "sources"];

const FIRECRAWL_ROW = {
	id: "sp_1",
	providerName: "firecrawl",
	enabled: true,
	maskedApiKey: "fc-…abcd",
	isDefault: true,
	priority: 0,
};

function stubAdapter(): ContextSourceSubmitAdapter {
	return {
		createUploadUrl: vi.fn(),
		processFile: vi.fn(),
		processLink: vi.fn(),
		createText: vi.fn(),
		listQueryKey: LIST_KEY,
	};
}

/**
 * Mirrors how both real owners host the Link tab: the hook (and its bulk
 * auto-close effect) lives in this always-mounted component, not in
 * DialogContent, so its `open` prop toggles the same way a dialog's
 * `open`/`onOpenChange` does — the Cancel button flips it here exactly as
 * `onCancel` flips it for a real dialog.
 */
function LinkDialogHost({
	adapter,
	onComplete,
	canManageSearchProviders,
}: {
	adapter: ContextSourceSubmitAdapter;
	onComplete: () => void;
	canManageSearchProviders: boolean;
}) {
	const [open, setOpen] = useState(true);
	const file = useFileSourceForm({ adapter, onComplete });
	const link = useUrlSourceForm({
		adapter,
		open,
		organizationId: "org-1",
		organizationSlug: "example-org",
		canManageSearchProviders,
		requireKnowledgeBaseCategory: false,
		allowLiveRefresh: true,
		onComplete,
	});
	const text = useTextSourceForm({ adapter, onComplete });
	const isLoading = file.isLoading || link.isLoading || text.isLoading;

	return (
		<>
			{/* Opens the dialog again after Cancel closed it. */}
			{!open && (
				<button type="button" onClick={() => setOpen(true)}>
					Reopen
				</button>
			)}
			<UrlSourceTabContent form={link} isLoading={isLoading} />
			<ContextSourceSubmitFooter
				tab="link"
				file={file}
				link={link}
				text={text}
				isLoading={isLoading}
				onCancel={() => setOpen(false)}
			/>
		</>
	);
}

function renderHost(
	adapter: ContextSourceSubmitAdapter,
	{
		canManageSearchProviders = true,
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false, refetchOnWindowFocus: false },
				mutations: { retry: false },
			},
		}),
	}: {
		/** The viewer is an organization admin or owner. */
		canManageSearchProviders?: boolean;
		queryClient?: QueryClient;
	} = {},
) {
	const onComplete = vi.fn();
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	render(
		<QueryClientProvider client={queryClient}>
			<LinkDialogHost
				adapter={adapter}
				onComplete={onComplete}
				canManageSearchProviders={canManageSearchProviders}
			/>
		</QueryClientProvider>,
	);
	return { onComplete, invalidateSpy, queryClient };
}

async function waitForPreflight() {
	await screen.findByTestId("url-source-indexing-with");
}

async function pasteBulkUrls(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
	const textarea = await screen.findByLabelText(/URLs \(one per line\)/i);
	await user.click(textarea);
	await user.paste(
		["https://example.com/about", "https://example.com/careers"].join("\n"),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// `clearAllMocks` keeps queued `…Once` answers; a test that stops early
	// must not hand its unread ones to the next test.
	getOrgProvidersMock.mockReset();
	getOrgProvidersMock.mockResolvedValue([FIRECRAWL_ROW]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useUrlSourceForm — bulk auto-close timer tied to `open`", () => {
	it("cancels the pending auto-close when the dialog closes before it fires", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		(adapter.processLink as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined,
		);
		const { onComplete } = renderHost(adapter);
		await waitForPreflight();

		await pasteBulkUrls(user);
		await user.click(screen.getByRole("button", { name: /^Add 2 URLs$/ }));
		await waitFor(() =>
			expect(adapter.processLink).toHaveBeenCalledTimes(2),
		);

		// The batch settled fully successful, arming the 2s auto-close timer.
		// Close the dialog well before it fires — same effect as Escape or a
		// backdrop click, which the sibling fix now also blocks mid-submit,
		// but is unguarded here since this batch already finished.
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		// If the stale timer were still armed (pre-fix: keyed on `bulkResults`
		// only) it would call `onComplete` ~2s after the settle above.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(onComplete).not.toHaveBeenCalled();
	}, 10_000);
});

const COULD_NOT = /couldn[’']t|could not/i;
const SEARCH_PROVIDER = /search provider/i;

/**
 * The deepest elements whose text says the search providers could not be
 * loaded. Matched on `textContent` so the wording can be split across inline
 * elements; the ancestors that merely contain such an element are skipped.
 */
function preflightErrorElements(): HTMLElement[] {
	const says = (element: Element | null) => {
		const text = element?.textContent ?? "";
		return COULD_NOT.test(text) && SEARCH_PROVIDER.test(text);
	};
	return screen.queryAllByText(
		(_content, element) =>
			says(element) &&
			Array.from(element?.children ?? []).every((child) => !says(child)),
	);
}

function searchProviderSettingsLinks(): HTMLElement[] {
	return screen
		.queryAllByRole("link")
		.filter((link) =>
			(link.getAttribute("href") ?? "").includes(
				"settings/search-providers",
			),
		);
}

/** A member gets neither a link to the provider settings nor directions to them. */
function expectNoSettingsPointer() {
	expect(searchProviderSettingsLinks()).toHaveLength(0);
	expect(
		screen.queryByText(/Settings → Search Providers/),
	).not.toBeInTheDocument();
}

describe("useUrlSourceForm — the provider pre-flight request fails (Fizzy #3068)", () => {
	it("says the providers could not be loaded, offers Try again, and recovers once the retry succeeds", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		(adapter.processLink as ReturnType<typeof vi.fn>).mockResolvedValue(
			undefined,
		);
		// The first read fails the way a dropped connection or a 5xx does;
		// the retry then finds the organization's Firecrawl key.
		getOrgProvidersMock.mockRejectedValueOnce(new Error("Network error"));
		renderHost(adapter);

		await waitFor(() =>
			expect(
				preflightErrorElements(),
				"an element saying the search providers could not be loaded",
			).not.toHaveLength(0),
		);
		// A failed read is not evidence that nothing is configured, so the
		// configure card and its settings link stay away.
		expect(screen.queryByText(/Configure one in/i)).not.toBeInTheDocument();
		expect(
			screen.queryByText(
				/URL sources need a search provider with scraping/i,
			),
		).not.toBeInTheDocument();
		expect(searchProviderSettingsLinks()).toHaveLength(0);

		await user.click(screen.getByRole("button", { name: /try again/i }));

		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(2),
		);
		await waitForPreflight();
		expect(preflightErrorElements()).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: /try again/i }),
		).not.toBeInTheDocument();

		// The form works again: a link can be added.
		await user.type(screen.getByLabelText("URL"), "https://example.com/");
		const submit = screen.getByRole("button", { name: /^Add Context$/ });
		expect(submit).toBeEnabled();
		await user.click(submit);
		await waitFor(() =>
			expect(adapter.processLink).toHaveBeenCalledWith(
				expect.objectContaining({ url: "https://example.com/" }),
			),
		);
	});
});

const SETTINGS_PATH = "/app/example-org/settings/search-providers";
const PREFLIGHT_KEY = ["url-source-providers-preflight", "org-1"];

/** Firecrawl's key is saved, but the provider is switched off. */
const DISABLED_FIRECRAWL_ROW = {
	...FIRECRAWL_ROW,
	enabled: false,
	maskedApiKey: "fc-…1234",
};
const DISABLED_JINA_ROW = {
	id: "sp_2",
	providerName: "jina",
	enabled: false,
	maskedApiKey: "jina-…5678",
	isDefault: false,
	priority: 1,
};
/** On and keyed, but Parallel only searches; it cannot read a page. */
const PARALLEL_ROW = {
	id: "sp_3",
	providerName: "parallel",
	enabled: true,
	maskedApiKey: "par-…9012",
	isDefault: false,
	priority: 2,
};
const YOUTUBE_ROW = {
	id: "sp_4",
	providerName: "youtube",
	enabled: true,
	maskedApiKey: "yt-…3456",
	isDefault: false,
	priority: 3,
};

const NOTHING_CONFIGURED = /URL sources need a search provider with scraping/i;
const TURNED_OFF = /connected but turned off/i;
const SEARCH_ONLY = /can search the web but can[’']t read pages/i;
const ASK_AN_ADMIN = /organization admin/i;

function processLinkOf(adapter: ContextSourceSubmitAdapter) {
	return adapter.processLink as ReturnType<typeof vi.fn>;
}

function addContextButton(): HTMLElement {
	return screen.getByRole("button", { name: /^Add Context$/ });
}

async function typeUrl(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("URL"), "https://example.com/");
}

/**
 * The submit button's tooltip. The button is disabled, so it is opened by
 * focusing the wrapper the footer keeps focusable for exactly this.
 */
async function submitTooltip(): Promise<HTMLElement> {
	const trigger = addContextButton().parentElement;
	if (!trigger) {
		throw new Error("The submit button has no tooltip trigger");
	}
	act(() => trigger.focus());
	return screen.findByRole("tooltip");
}

function settingsLinkHrefs(): (string | null)[] {
	return searchProviderSettingsLinks().map((link) =>
		link.getAttribute("href"),
	);
}

/** None of the pre-flight's cards — configuration or error — is showing. */
function expectNoPreflightCard() {
	expect(screen.queryByText(NOTHING_CONFIGURED)).not.toBeInTheDocument();
	expect(screen.queryByText(TURNED_OFF)).not.toBeInTheDocument();
	expect(screen.queryByText(SEARCH_ONLY)).not.toBeInTheDocument();
	expect(preflightErrorElements()).toHaveLength(0);
	expect(
		screen.queryByRole("button", { name: /try again/i }),
	).not.toBeInTheDocument();
}

describe("useUrlSourceForm — what the pre-flight tells the viewer (Fizzy #3068)", () => {
	it("names a scrape provider that is connected but turned off, and links an admin to turn it on", async () => {
		getOrgProvidersMock.mockResolvedValue([DISABLED_FIRECRAWL_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: true });

		expect(
			await screen.findByText(/Firecrawl is connected but turned off/i),
		).toBeInTheDocument();
		// A saved key is not "nothing configured".
		expect(screen.queryByText(NOTHING_CONFIGURED)).not.toBeInTheDocument();
		expect(screen.getByText(/Turn it on in/i)).toBeInTheDocument();
		expect(settingsLinkHrefs()).toEqual([SETTINGS_PATH]);

		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
	});

	it("asks a member to have an organization admin turn the provider on, without a settings link", async () => {
		getOrgProvidersMock.mockResolvedValue([DISABLED_FIRECRAWL_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: false });

		expect(
			await screen.findByText(/Firecrawl is connected but turned off/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/organization admin to turn it on/i),
		).toBeInTheDocument();
		expectNoSettingsPointer();

		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
	});

	it("names every switched-off scrape provider, ahead of a provider that only searches", async () => {
		getOrgProvidersMock.mockResolvedValue([
			DISABLED_FIRECRAWL_ROW,
			DISABLED_JINA_ROW,
			PARALLEL_ROW,
		]);
		renderHost(stubAdapter(), { canManageSearchProviders: true });

		expect(
			await screen.findByText(
				/Firecrawl and Jina AI are connected but turned off/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(SEARCH_ONLY)).not.toBeInTheDocument();
		expect(settingsLinkHrefs()).toEqual([SETTINGS_PATH]);
	});

	it("says a provider that only searches cannot read pages, lists the ones that can, and links an admin to connect one", async () => {
		getOrgProvidersMock.mockResolvedValue([PARALLEL_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: true });

		expect(
			await screen.findByText(
				/Parallel can search the web but can[’']t read pages/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/URL sources need Firecrawl, Jina, Tavily, Exa, or Cloudflare Browser Rendering/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(NOTHING_CONFIGURED)).not.toBeInTheDocument();
		expect(screen.getByText(/Connect one in/i)).toBeInTheDocument();
		expect(settingsLinkHrefs()).toEqual([SETTINGS_PATH]);

		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
	});

	it("tells a member which connected providers only search and to ask an organization admin, without a settings link", async () => {
		getOrgProvidersMock.mockResolvedValue([PARALLEL_ROW, YOUTUBE_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: false });

		expect(
			await screen.findByText(
				/Parallel and YouTube can search the web but can[’']t read pages/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/organization admin to connect one/i),
		).toBeInTheDocument();
		expectNoSettingsPointer();

		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
	});

	it("asks a member to have an organization admin connect a provider when none is configured, in the card and the submit tooltip", async () => {
		getOrgProvidersMock.mockResolvedValue([]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: false });

		expect(await screen.findByText(NOTHING_CONFIGURED)).toBeInTheDocument();
		expect(
			screen.getByText(/organization admin to connect one/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/Configure one in/i)).not.toBeInTheDocument();
		expectNoSettingsPointer();

		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
		expect(await submitTooltip()).toHaveTextContent(
			/Ask an organization admin to connect a search provider/i,
		);
	});

	it("shows no card and holds submit while the first answer is on its way", async () => {
		// The providers request never answers.
		getOrgProvidersMock.mockReturnValue(new Promise(() => {}));
		const user = userEvent.setup();
		renderHost(stubAdapter());

		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(1),
		);
		await typeUrl(user);

		expectNoPreflightCard();
		expect(
			screen.queryByTestId("url-source-indexing-with"),
		).not.toBeInTheDocument();
		expect(addContextButton()).toBeDisabled();
		expect(await submitTooltip()).toHaveTextContent(
			/Checking search providers/i,
		);
	});

	it("lets a viewer who may not list the providers add a link, and shows the server's refusal without a settings link", async () => {
		// A project guest is not a member of the organization, so listing its
		// search providers is refused — every time, including the re-read
		// after a refused submit.
		getOrgProvidersMock.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Not a member of this organization",
			}),
		);
		const adapter = stubAdapter();
		processLinkOf(adapter).mockRejectedValueOnce({
			data: {
				code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
				settingsPath: SETTINGS_PATH,
			},
			message: "URL sources need a search provider with scraping.",
		});
		const user = userEvent.setup();
		renderHost(adapter, { canManageSearchProviders: false });

		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(1),
		);
		await typeUrl(user);
		// Past `checking`: the refusal is in, and it does not block submit.
		await waitFor(() => expect(addContextButton()).toBeEnabled());
		// A refusal says nothing about configuration, and is not an outage.
		expectNoPreflightCard();

		await user.click(addContextButton());
		await waitFor(() =>
			expect(processLinkOf(adapter)).toHaveBeenCalledWith(
				expect.objectContaining({ url: "https://example.com/" }),
			),
		);

		// The server decided: nothing can read pages. A guest cannot change
		// the organization's providers, so no link to its settings.
		expect(await screen.findByText(NOTHING_CONFIGURED)).toBeInTheDocument();
		expect(screen.getByText(ASK_AN_ADMIN)).toBeInTheDocument();
		expectNoSettingsPointer();
	});

	it("asks a member to have an organization admin connect a crawl provider when the server refuses a path-prefix crawl", async () => {
		const adapter = stubAdapter();
		processLinkOf(adapter).mockRejectedValueOnce({
			data: {
				code: "CRAWL_PROVIDER_NOT_CONFIGURED",
				settingsPath: SETTINGS_PATH,
			},
			message: "Path-prefix crawls require a crawl provider.",
		});
		const user = userEvent.setup();
		renderHost(adapter, { canManageSearchProviders: false });

		await screen.findByTestId("url-source-indexing-with");
		await typeUrl(user);
		await user.click(screen.getByRole("radio", { name: /path-prefix/i }));
		await user.click(addContextButton());

		expect(await screen.findByText("Crawl provider")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Ask an organization admin to connect one, or pick Single page/,
			),
		).toBeInTheDocument();
		expectNoSettingsPointer();
	});

	it("still submits while the providers could not be checked", async () => {
		getOrgProvidersMock.mockRejectedValue(new Error("Network error"));
		const adapter = stubAdapter();
		processLinkOf(adapter).mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderHost(adapter);

		await waitFor(() =>
			expect(
				preflightErrorElements(),
				"an element saying the search providers could not be loaded",
			).not.toHaveLength(0),
		);
		await typeUrl(user);
		expect(addContextButton()).toBeEnabled();

		await user.click(addContextButton());
		await waitFor(() =>
			expect(processLinkOf(adapter)).toHaveBeenCalledWith(
				expect.objectContaining({ url: "https://example.com/" }),
			),
		);
	});

	it("keeps the answer it has when a later re-read fails", async () => {
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce([FIRECRAWL_ROW])
			.mockRejectedValue(new Error("Network error"));
		const user = userEvent.setup();
		const { queryClient } = renderHost(stubAdapter());

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.click(screen.getByRole("button", { name: /try again/i }));
		await waitForPreflight();

		// A later re-read (window focus, a refused submit) fails.
		await act(() =>
			queryClient.refetchQueries({ queryKey: PREFLIGHT_KEY }),
		);
		expect(getOrgProvidersMock).toHaveBeenCalledTimes(3);
		expect(queryClient.getQueryState(PREFLIGHT_KEY)?.status).toBe("error");

		// Firecrawl was there a moment ago; one failed read does not undo it.
		expectNoPreflightCard();
		expect(
			screen.getByTestId("url-source-indexing-with"),
		).toHaveTextContent(/Firecrawl/);
		await typeUrl(user);
		expect(addContextButton()).toBeEnabled();
	});

	it("stops blocking on an earlier no-provider answer once a re-read of it fails", async () => {
		getOrgProvidersMock
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValue([FIRECRAWL_ROW]);
		const user = userEvent.setup();
		const { queryClient } = renderHost(stubAdapter());

		expect(await screen.findByText(NOTHING_CONFIGURED)).toBeInTheDocument();
		// An admin connects Firecrawl elsewhere; the re-read on return fails.
		await act(() =>
			queryClient.refetchQueries({ queryKey: PREFLIGHT_KEY }),
		);

		// "No provider" can no longer be confirmed, so it stops blocking and
		// the viewer can retry instead.
		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		expect(screen.queryByText(NOTHING_CONFIGURED)).not.toBeInTheDocument();
		await typeUrl(user);
		expect(addContextButton()).toBeEnabled();

		await user.click(screen.getByRole("button", { name: /try again/i }));
		await waitForPreflight();
		expectNoPreflightCard();
	});

	it("lets a viewer who may not list the providers ask for a path-prefix crawl and leaves the check to the server", async () => {
		getOrgProvidersMock.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Not a member of this organization",
			}),
		);
		const adapter = stubAdapter();
		processLinkOf(adapter).mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderHost(adapter, { canManageSearchProviders: false });

		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(1),
		);
		// A documentation section auto-detects as a path-prefix crawl on blur.
		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/docs/",
		);
		await user.tab();
		const pathPrefix = screen.getByRole("radio", { name: /path-prefix/i });
		expect(pathPrefix).toBeEnabled();
		await waitFor(() => expect(pathPrefix).toBeChecked());

		await user.click(addContextButton());
		await waitFor(() =>
			expect(processLinkOf(adapter)).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://example.com/docs/",
					scope: "PATH_PREFIX",
				}),
			),
		);
	});

	it("reads the providers again each time the dialog opens, even within the app's cache window", async () => {
		// The app's QueryClient keeps an answer fresh for a minute.
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { staleTime: 60_000, retry: false },
				mutations: { retry: false },
			},
		});
		getOrgProvidersMock
			.mockResolvedValueOnce([])
			.mockResolvedValue([FIRECRAWL_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { queryClient });

		expect(await screen.findByText(NOTHING_CONFIGURED)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		// Meanwhile an admin connects Firecrawl in settings.
		await user.click(screen.getByRole("button", { name: "Reopen" }));

		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(2),
		);
		await waitForPreflight();
		expect(screen.queryByText(NOTHING_CONFIGURED)).not.toBeInTheDocument();
	});
});

/** A promise the test settles by hand, for a request still on its way. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function tryAgainButton(): HTMLElement {
	return screen.getByRole("button", { name: /try again/i });
}

/** On and keyed, but Jina reads single pages only; it cannot crawl a path. */
const JINA_ROW = {
	...DISABLED_JINA_ROW,
	enabled: true,
	isDefault: true,
	priority: 0,
};

describe("useUrlSourceForm — a pre-flight read still on its way (Fizzy #3068)", () => {
	it("keeps the error card, an enabled Try again marked busy, and an open submit while a retry is on its way, then clears the card when it succeeds", async () => {
		const retry = deferred<(typeof FIRECRAWL_ROW)[]>();
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockImplementationOnce(() => retry.promise);
		const user = userEvent.setup();
		renderHost(stubAdapter());

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.click(tryAgainButton());
		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(2),
		);
		await typeUrl(user);

		// The retry has not answered: nothing is known that was not known a
		// moment ago, so the card stays and nothing new blocks submit.
		await waitFor(() =>
			expect(tryAgainButton()).toHaveAttribute("aria-busy", "true"),
		);
		expect(tryAgainButton()).toBeEnabled();
		expect(preflightErrorElements()).not.toHaveLength(0);
		expect(addContextButton()).toBeEnabled();

		await act(async () => {
			retry.resolve([FIRECRAWL_ROW]);
		});

		await waitForPreflight();
		expect(
			screen.getByTestId("url-source-indexing-with"),
		).toHaveTextContent(/Indexing with Firecrawl/);
		expectNoPreflightCard();
		expect(addContextButton()).toBeEnabled();
	});

	it("keeps the error card and stops marking Try again busy when the retry fails too", async () => {
		const retry = deferred<(typeof FIRECRAWL_ROW)[]>();
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockImplementationOnce(() => retry.promise);
		const user = userEvent.setup();
		renderHost(stubAdapter());

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.click(tryAgainButton());
		await waitFor(() =>
			expect(tryAgainButton()).toHaveAttribute("aria-busy", "true"),
		);

		await act(async () => {
			retry.reject(new Error("Network error"));
		});

		await waitFor(() =>
			expect(tryAgainButton()).not.toHaveAttribute("aria-busy", "true"),
		);
		expect(getOrgProvidersMock).toHaveBeenCalledTimes(2);
		expect(preflightErrorElements()).not.toHaveLength(0);
		expect(tryAgainButton()).toBeEnabled();
		await typeUrl(user);
		expect(addContextButton()).toBeEnabled();
	});

	it("announces a retry that fails again by replacing the alert's message", async () => {
		const retry = deferred<(typeof FIRECRAWL_ROW)[]>();
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockImplementationOnce(() => retry.promise);
		const user = userEvent.setup();
		renderHost(stubAdapter());

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		const firstMessage = preflightErrorElements()[0];
		await user.click(tryAgainButton());
		await act(async () => {
			retry.reject(new Error("Network error"));
		});

		await waitFor(() =>
			expect(tryAgainButton()).not.toHaveAttribute("aria-busy", "true"),
		);
		// Same words, new node: a live region only speaks when its content
		// changes, and the button the viewer pressed keeps focus.
		expect(preflightErrorElements()[0]).not.toBe(firstMessage);
		expect(screen.getByRole("alert")).toContainElement(
			preflightErrorElements()[0],
		);
	});

	it("starts a reopened dialog at checking, not at the failure from the last time it was open", async () => {
		const reread = deferred<(typeof FIRECRAWL_ROW)[]>();
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockImplementationOnce(() => reread.promise);
		const user = userEvent.setup();
		renderHost(stubAdapter());

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await user.click(screen.getByRole("button", { name: "Reopen" }));
		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(2),
		);

		// Nobody pressed Try again: the re-read is a fresh check.
		expect(preflightErrorElements()).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: /try again/i }),
		).not.toBeInTheDocument();
		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();

		await act(async () => {
			reread.resolve([FIRECRAWL_ROW]);
		});
		await waitForPreflight();
		expect(addContextButton()).toBeEnabled();
	});

	it("says no connected provider can crawl the path when a bulk row is refused only for crawling", async () => {
		// A guest cannot see which providers can crawl, so path-prefix stays
		// open and the server answers for each row.
		getOrgProvidersMock.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Not a member of this organization",
			}),
		);
		const adapter = stubAdapter();
		processLinkOf(adapter).mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				message:
					"Path-prefix crawls require Firecrawl or Cloudflare Browser Rendering. Configure one in Settings → Search Providers.",
				data: {
					code: "CRAWL_PROVIDER_NOT_CONFIGURED",
					settingsPath: SETTINGS_PATH,
				},
			}),
		);
		const user = userEvent.setup();
		renderHost(adapter, { canManageSearchProviders: false });
		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(1),
		);

		await user.click(
			await screen.findByRole("radio", { name: /path-prefix/i }),
		);
		await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
		await user.click(
			await screen.findByLabelText(/URLs \(one per line\)/i),
		);
		await user.paste(
			["https://example.com/docs/", "https://example.com/help/"].join(
				"\n",
			),
		);
		await user.click(screen.getByRole("button", { name: /^Add 2 URLs$/ }));

		expect(
			await screen.findAllByText(
				/No connected search provider can crawl this path\./,
			),
		).toHaveLength(2);
		expect(
			screen.queryByText(/No connected search provider can add this URL/),
		).not.toBeInTheDocument();
		expectNoSettingsPointer();
	});

	it("shows the configuration card and holds submit once a retry answers that nothing can read pages", async () => {
		// A failed read followed by a real answer: the answer is what counts,
		// not the failure before it.
		getOrgProvidersMock
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValueOnce([]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: true });

		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.click(tryAgainButton());

		expect(await screen.findByText(NOTHING_CONFIGURED)).toBeInTheDocument();
		expect(preflightErrorElements()).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: /try again/i }),
		).not.toBeInTheDocument();
		await typeUrl(user);
		expect(addContextButton()).toBeDisabled();
	});

	it("keeps a ready answer in charge while a later re-read is on its way", async () => {
		const user = userEvent.setup();
		const { queryClient } = renderHost(stubAdapter());
		await waitForPreflight();
		await typeUrl(user);

		// A re-read (window focus, a refused submit) starts and has not
		// answered yet.
		const reread = deferred<(typeof FIRECRAWL_ROW)[]>();
		getOrgProvidersMock.mockImplementationOnce(() => reread.promise);
		let refetch: Promise<void> | undefined;
		act(() => {
			refetch = queryClient.refetchQueries({ queryKey: PREFLIGHT_KEY });
		});
		await waitFor(() =>
			expect(getOrgProvidersMock).toHaveBeenCalledTimes(2),
		);
		expect(queryClient.getQueryState(PREFLIGHT_KEY)?.fetchStatus).toBe(
			"fetching",
		);

		expectNoPreflightCard();
		expect(
			screen.getByTestId("url-source-indexing-with"),
		).toHaveTextContent(/Indexing with Firecrawl/);
		expect(addContextButton()).toBeEnabled();

		await act(async () => {
			reread.resolve([FIRECRAWL_ROW]);
			await refetch;
		});
		expectNoPreflightCard();
		expect(addContextButton()).toBeEnabled();
	});
});

describe("useUrlSourceForm — path-prefix crawls and the pre-flight (Fizzy #3068)", () => {
	it("lets a viewer pick a path-prefix crawl while the providers could not be checked, and leaves the check to the server", async () => {
		// A failed read, not a refusal: every read fails.
		getOrgProvidersMock.mockRejectedValue(new Error("Network error"));
		const adapter = stubAdapter();
		processLinkOf(adapter).mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderHost(adapter);

		// While the first answer is on its way the radio is closed, so the
		// auto-detect below must run only once the read has failed.
		await waitFor(() =>
			expect(preflightErrorElements()).not.toHaveLength(0),
		);
		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/docs/",
		);
		await user.tab();
		const pathPrefix = screen.getByRole("radio", { name: /path-prefix/i });
		expect(pathPrefix).toBeEnabled();
		await waitFor(() => expect(pathPrefix).toBeChecked());

		await user.click(addContextButton());
		await waitFor(() =>
			expect(processLinkOf(adapter)).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://example.com/docs/",
					scope: "PATH_PREFIX",
				}),
			),
		);
	});

	/**
	 * The closed path-prefix radio's tooltip. Its wrapper is not focusable,
	 * so it is opened the way a pointer reaches it.
	 */
	async function pathPrefixTooltip(
		user: ReturnType<typeof userEvent.setup>,
	): Promise<HTMLElement> {
		const wrapper = screen.getByLabelText(/^Path-prefix scope \(disabled/i);
		await user.hover(wrapper);
		return screen.findByRole("tooltip", {}, { timeout: 2_000 });
	}

	it("tells an admin where to connect a crawl provider when only a single-page reader is on", async () => {
		getOrgProvidersMock.mockResolvedValue([JINA_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: true });
		await waitForPreflight();
		expect(document.getElementById("url-scope-prefix")).toBeDisabled();

		const tooltip = await pathPrefixTooltip(user);
		expect(tooltip).toHaveTextContent(
			/Path-prefix crawls require Firecrawl or Cloudflare Browser Rendering/,
		);
		expect(tooltip).toHaveTextContent(
			/Configure one in Settings → Search Providers/,
		);
		expect(tooltip).not.toHaveTextContent(ASK_AN_ADMIN);
	});

	it("asks a member to have an organization admin connect a crawl provider when only a single-page reader is on", async () => {
		getOrgProvidersMock.mockResolvedValue([JINA_ROW]);
		const user = userEvent.setup();
		renderHost(stubAdapter(), { canManageSearchProviders: false });
		await waitForPreflight();
		expect(document.getElementById("url-scope-prefix")).toBeDisabled();

		const tooltip = await pathPrefixTooltip(user);
		expect(tooltip).toHaveTextContent(
			/Path-prefix crawls require Firecrawl or Cloudflare Browser Rendering/,
		);
		expect(tooltip).toHaveTextContent(
			/Ask an organization admin to connect one/,
		);
		expect(tooltip).not.toHaveTextContent(/Configure one/);
	});
});

describe("describeUnusableProviders (Fizzy #3068)", () => {
	it("counts a provider without a saved key for neither list, whether it is on or off", () => {
		expect(
			describeUnusableProviders([
				{
					providerName: "firecrawl",
					enabled: false,
					maskedApiKey: null,
				},
				{ providerName: "parallel", enabled: true, maskedApiKey: null },
			]),
		).toEqual({ disabledScrapeProviders: [], searchOnlyProviders: [] });
	});

	it("names a keyed scrape provider that is off and a keyed one that only searches, and leaves out one that can read pages", () => {
		expect(
			describeUnusableProviders([
				{
					providerName: "jina",
					enabled: false,
					maskedApiKey: "jina-…5678",
				},
				{
					providerName: "youtube",
					enabled: true,
					maskedApiKey: "yt-…3456",
				},
				{
					providerName: "firecrawl",
					enabled: true,
					maskedApiKey: "fc-…abcd",
				},
			]),
		).toEqual({
			disabledScrapeProviders: ["jina"],
			searchOnlyProviders: ["YouTube"],
		});
	});
});

describe("useUrlSourceForm — mixed bulk results", () => {
	it("invalidates the list for the URLs that landed even though the batch also hit the provider gate", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		(adapter.processLink as ReturnType<typeof vi.fn>).mockImplementation(
			async ({ url }: { url: string }) => {
				if (url.includes("careers")) {
					const err = new Error(
						"Search provider not configured",
					) as Error & {
						data: { code: string };
					};
					err.data = { code: "SCRAPE_PROVIDER_NOT_CONFIGURED" };
					throw err;
				}
				return undefined;
			},
		);
		const { onComplete, invalidateSpy } = renderHost(adapter);
		await waitForPreflight();

		await pasteBulkUrls(user);
		await user.click(screen.getByRole("button", { name: /^Add 2 URLs$/ }));

		await waitFor(() =>
			expect(adapter.processLink).toHaveBeenCalledTimes(2),
		);
		// The provider-gate notice takes over the status...
		await screen.findByText(/Configure one in/i);
		// ...but the URL that succeeded before the gate must still show up.
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
		// A batch that hit the provider gate keeps the dialog open for the
		// user to see the notice.
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("says no connected provider can add a row the provider gate refused, instead of the server's settings hint, and keeps other rows' reasons (Fizzy #3068)", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		processLinkOf(adapter).mockImplementation(
			async ({ url }: { url: string }) => {
				if (url.includes("careers")) {
					// The server's refusal is written for someone who can
					// change the organization's providers.
					throw new ORPCError("BAD_REQUEST", {
						message:
							"URL sources need a search provider with scraping. Configure one in Settings → Search Providers.",
						data: {
							code: "SCRAPE_PROVIDER_NOT_CONFIGURED",
							settingsPath: SETTINGS_PATH,
						},
					});
				}
				if (url.includes("pricing")) {
					throw new Error("The page returned 404.");
				}
				return undefined;
			},
		);
		renderHost(adapter, { canManageSearchProviders: false });
		await waitForPreflight();

		await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
		await user.click(
			await screen.findByLabelText(/URLs \(one per line\)/i),
		);
		await user.paste(
			[
				"https://example.com/about",
				"https://example.com/careers",
				"https://example.com/pricing",
			].join("\n"),
		);
		await user.click(screen.getByRole("button", { name: /^Add 3 URLs$/ }));
		await waitFor(() =>
			expect(processLinkOf(adapter)).toHaveBeenCalledTimes(3),
		);

		const refused = await screen.findByText(
			/No connected search provider can add this URL\./,
		);
		expect(refused.closest("li")).toHaveTextContent(
			"https://example.com/careers",
		);
		// A failure the gate did not cause keeps the server's reason.
		expect(
			screen.getByText(/The page returned 404\./).closest("li"),
		).toHaveTextContent("https://example.com/pricing");
		// A member cannot configure providers, so nothing tells them to.
		expect(
			screen.queryByText(/Configure one in Settings/i),
		).not.toBeInTheDocument();
		expectNoSettingsPointer();
	});
});
