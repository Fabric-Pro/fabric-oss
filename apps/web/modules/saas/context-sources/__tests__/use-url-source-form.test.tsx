/**
 * Hook tests for `useUrlSourceForm` that don't belong to either owner's own
 * suite: the bulk auto-close timer's lifetime tied to `open`, and list
 * invalidation on a mixed bulk result. Both are owner-agnostic — the hook is
 * driven here through the same shared tab body + footer the owners render,
 * following the harness in `submit-adapter.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
}: {
	adapter: ContextSourceSubmitAdapter;
	onComplete: () => void;
}) {
	const [open, setOpen] = useState(true);
	const file = useFileSourceForm({ adapter, onComplete });
	const link = useUrlSourceForm({
		adapter,
		open,
		organizationId: "org-1",
		organizationSlug: "example-org",
		requireKnowledgeBaseCategory: false,
		allowLiveRefresh: true,
		onComplete,
	});
	const text = useTextSourceForm({ adapter, onComplete });
	const isLoading = file.isLoading || link.isLoading || text.isLoading;

	return (
		<>
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

function renderHost(adapter: ContextSourceSubmitAdapter) {
	const onComplete = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	render(
		<QueryClientProvider client={queryClient}>
			<LinkDialogHost adapter={adapter} onComplete={onComplete} />
		</QueryClientProvider>,
	);
	return { onComplete, invalidateSpy };
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
});
