/**
 * @vitest-environment jsdom
 */

/**
 * The OneDrive / SharePoint entry of the Add Context dialog (Fizzy #2808).
 *
 * Pinned: shown only while the document-folder feature is on, and only after
 * the project exists (the wizard's draft has no Context tab to follow the
 * folders on); it opens the folder picker, and a connect closes the dialog.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const mocks = vi.hoisted(() => ({
	flags: new Set<string>(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => mocks.flags.has(key),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				list: vi.fn().mockResolvedValue({ contexts: [] }),
				createUploadUrl: vi.fn(),
				processFile: vi.fn(),
				processLink: vi.fn(),
			},
		},
		searchProviders: {
			getUserProviders: vi.fn().mockResolvedValue([]),
			getOrganizationProviders: vi.fn().mockResolvedValue([]),
		},
		mcp: { configs: { list: vi.fn().mockResolvedValue([]) } },
		dataConnections: {
			list: vi.fn().mockResolvedValue({ connections: [] }),
		},
		workflows: {
			integrations: {
				listStatus: vi.fn().mockResolvedValue({ integrations: [] }),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
	useContextPath: (p: string) => `/app/example-org/${p}`,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: () => null,
}));
vi.mock("../SlackChannelSelectorDialog", () => ({
	SlackChannelSelectorDialog: () => null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));
vi.mock("../ConfluenceResourceBrowser", () => ({
	ConfluenceResourceBrowser: () => null,
}));
vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));
vi.mock("../IntegrationPageBrowser", () => ({
	IntegrationPageBrowser: () => null,
}));

vi.mock("../document-folders/ConnectDocumentFolderDialog", () => ({
	ConnectDocumentFolderDialog: (props: {
		projectId: string;
		organizationId: string | null;
		onConnected?: () => void;
	}) => (
		<div data-testid="document-folder-picker">
			{props.projectId}/{props.organizationId}
			<button type="button" onClick={() => props.onConnected?.()}>
				Finish connecting
			</button>
		</div>
	),
}));

import { ContextUploaderDialog } from "../ContextUploaderDialog";

function renderDialog(
	surface: "wizard" | "post-creation" = "post-creation",
	onOpenChange = vi.fn(),
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ContextUploaderDialog
				open
				onOpenChange={onOpenChange}
				projectId="proj-1"
				surface={surface}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flags.clear();
});

describe("ContextUploaderDialog — OneDrive / SharePoint entry", () => {
	it("is hidden while the feature is off", () => {
		renderDialog();
		expect(screen.getByRole("tab", { name: "File" })).toBeInTheDocument();
		expect(
			screen.queryByRole("tab", { name: /OneDrive/ }),
		).not.toBeInTheDocument();
	});

	it("is hidden in the project wizard", () => {
		mocks.flags.add("CLOUD_DRIVE_FOLDERS");
		renderDialog("wizard");
		expect(
			screen.queryByRole("tab", { name: /OneDrive/ }),
		).not.toBeInTheDocument();
	});

	it("opens the folder picker, and closes the dialog once folders are connected", async () => {
		mocks.flags.add("CLOUD_DRIVE_FOLDERS");
		const { onOpenChange } = renderDialog();

		await userEvent.click(
			screen.getByRole("tab", { name: "OneDrive / SharePoint" }),
		);
		expect(
			screen.queryByTestId("document-folder-picker"),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "Choose folders" }),
		);
		expect(screen.getByTestId("document-folder-picker")).toHaveTextContent(
			"proj-1/org-1",
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Finish connecting",
				// The stand-in renders under the open dialog; the real picker
				// is a dialog of its own on top of it.
				hidden: true,
			}),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
