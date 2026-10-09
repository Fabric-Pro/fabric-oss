import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
const setOrganizationUse = vi.fn();
const disconnect = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			chatgptPlan: {
				status: (input: unknown) => status(input),
				setOrganizationUse: (input: unknown) =>
					setOrganizationUse(input),
				disconnect: (input: unknown) => disconnect(input),
			},
		},
	},
}));

const flag = { current: true };
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "CHATGPT_PLAN" && flag.current,
}));

const activeSlug = { current: "example-org" as string | null };
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization:
			activeSlug.current === null ? null : { slug: activeSlug.current },
	}),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const pathname = vi.fn(() => "/app/example-org");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

vi.mock("next-intl", () => {
	const lookup = (path: string): string => {
		let node: unknown = en;
		for (const segment of path.split(".")) {
			node =
				typeof node === "object" && node !== null
					? Reflect.get(node, segment)
					: undefined;
		}
		return typeof node === "string" ? node : path;
	};
	return {
		useTranslations: (namespace: string) =>
			Object.assign(
				(key: string, values?: Record<string, string | number>) =>
					lookup(`${namespace}.${key}`).replace(
						/\{(\w+)\}/g,
						(_match, name: string) =>
							values?.[name] === undefined
								? `{${name}}`
								: String(values[name]),
					),
				{
					has: (key: string) =>
						lookup(`${namespace}.${key}`) !== `${namespace}.${key}`,
				},
			),
	};
});

import { ChatgptPlanPrompt } from "../ChatgptPlanPrompt";
import {
	ChatgptPlanReconnectDockNotice,
	ChatgptPlanReconnectNotice,
} from "../ChatgptPlanReconnectActions";
import { ChatgptPlanSettings } from "../ChatgptPlanSettings";

const copy = en.settings.chatgptPlan;

type Status = {
	connected: boolean;
	email: string | null;
	status: "ACTIVE" | "NEEDS_RECONNECT" | null;
	currentOrganization: {
		slug: string | null;
		name: string;
		enabled: boolean;
		answered: boolean;
		includeBackgroundJobs: boolean;
	} | null;
	organizations: Array<{
		slug: string | null;
		name: string;
		enabled: boolean;
	}>;
	usageEstimate: {
		windowHours: number;
		windowStart: Date | null;
		resetsAt: Date | null;
		lastRequestAt: Date | null;
		requests: number;
		inputTokens: number;
		cachedInputTokens: number;
		outputTokens: number;
		estimatedPercent: number;
		topConsumers: Array<{
			kind: "job" | "feature" | "other";
			key: string | null;
			requests: number;
			inputTokens: number;
			percent: number;
		}>;
	} | null;
};

const NOT_CONNECTED: Status = {
	connected: false,
	email: null,
	status: null,
	currentOrganization: {
		slug: "example-org",
		name: "Example Org",
		enabled: false,
		answered: false,
		includeBackgroundJobs: false,
	},
	organizations: [
		{ slug: "example-org", name: "Example Org", enabled: false },
	],
	usageEstimate: null,
};

const CONNECTED: Status = {
	connected: true,
	email: "dev@example.com",
	status: "ACTIVE",
	currentOrganization: {
		slug: "example-org",
		name: "Example Org",
		enabled: true,
		answered: true,
		includeBackgroundJobs: false,
	},
	organizations: [
		{ slug: "example-org", name: "Example Org", enabled: true },
	],
	usageEstimate: {
		windowHours: 5,
		windowStart: null,
		resetsAt: null,
		lastRequestAt: new Date("2026-10-08T03:33:00Z"),
		requests: 12,
		inputTokens: 4000,
		cachedInputTokens: 0,
		outputTokens: 1200,
		estimatedPercent: 23.6,
		topConsumers: [],
	},
};

function renderWithClient(node: ReactNode) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{node}
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	flag.current = true;
	activeSlug.current = "example-org";
	setOrganizationUse.mockImplementation((input: { enabled: boolean }) =>
		Promise.resolve({ enabled: input.enabled }),
	);
	disconnect.mockResolvedValue({ disconnected: true });
});

describe("ChatGPT plan settings section", () => {
	it("renders nothing and fetches nothing while the flag is off", async () => {
		flag.current = false;
		status.mockResolvedValue(CONNECTED);

		const { container } = renderWithClient(<ChatgptPlanSettings />);

		expect(container.firstChild).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(status).not.toHaveBeenCalled();
	});

	it("tells a member with no plan how to connect, with a copyable command", async () => {
		status.mockResolvedValue(NOT_CONNECTED);

		renderWithClient(<ChatgptPlanSettings />);

		expect(await screen.findByText(copy.notConnected)).toBeInTheDocument();
		expect(screen.getByText("fabric connect chatgpt")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.copyCommand }),
		).toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.disconnect }),
		).not.toBeInTheDocument();
	});

	it("shows the connected account, the organization toggle, the estimate and disconnect", async () => {
		status.mockResolvedValue(CONNECTED);

		renderWithClient(<ChatgptPlanSettings />);

		expect(
			await screen.findByTestId("chatgpt-plan-email"),
		).toHaveTextContent("dev@example.com");
		expect(screen.getByText(copy.statusActive)).toBeInTheDocument();

		const toggle = screen.getByRole("switch", {
			name: copy.useInOrganization,
		});
		expect(toggle).toHaveAttribute("aria-checked", "true");

		expect(screen.getByTestId("chatgpt-plan-usage")).toHaveTextContent(
			"Fabric used about 24% of your 5-hour window (estimate)",
		);
		// The last window has reset: no reset time, and nobody "using" it.
		expect(
			screen.getByTestId("chatgpt-plan-window-timing"),
		).toHaveTextContent(
			/^Last request \d\d:\d\d( [AP]M)? · no open window$/,
		);
		expect(
			screen.queryByTestId("chatgpt-plan-window-consumers"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /ChatGPT Settings → Usage/ }),
		).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
		expect(
			screen.queryByTestId("chatgpt-plan-reconnect"),
		).not.toBeInTheDocument();

		await userEvent.click(toggle);
		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled: false,
			}),
		);
	});

	it("keeps the background-jobs toggle disabled while the plan is off here, with the warning always shown", async () => {
		status.mockResolvedValue({
			...CONNECTED,
			currentOrganization: {
				...(CONNECTED.currentOrganization as NonNullable<
					Status["currentOrganization"]
				>),
				enabled: false,
			},
		});

		renderWithClient(<ChatgptPlanSettings />);

		const nested = await screen.findByRole("switch", {
			name: copy.includeBackgroundJobs,
		});
		expect(nested).toBeDisabled();
		expect(nested).toHaveAttribute("aria-checked", "false");
		expect(
			screen.getByText(copy.backgroundJobsWarning),
		).toBeInTheDocument();
		expect(copy.backgroundJobsWarning).toContain(
			"AI agents that Fabric starts on your behalf",
		);
	});

	it("turns background jobs and agents on only through an explicit click", async () => {
		status.mockResolvedValue(CONNECTED);

		renderWithClient(<ChatgptPlanSettings />);

		const nested = await screen.findByRole("switch", {
			name: copy.includeBackgroundJobs,
		});
		expect(nested).toBeEnabled();
		expect(nested).toHaveAttribute("aria-checked", "false");
		expect(setOrganizationUse).not.toHaveBeenCalled();

		await userEvent.click(nested);
		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled: true,
				includeBackgroundJobs: true,
			}),
		);
	});

	it("disconnects only after the member confirms", async () => {
		status.mockResolvedValue(CONNECTED);
		renderWithClient(<ChatgptPlanSettings />);

		await userEvent.click(
			await screen.findByRole("button", { name: copy.disconnect }),
		);
		expect(disconnect).not.toHaveBeenCalled();

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(copy.disconnectConfirmTitle);
		const confirm = screen
			.getAllByRole("button", { name: copy.disconnect })
			.find((button) => dialog.contains(button));
		if (!confirm) {
			throw new Error("confirm button not found in the dialog");
		}
		await userEvent.click(confirm);

		await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
	});

	it("tells a member whose plan needs reconnecting to run the command again", async () => {
		status.mockResolvedValue({ ...CONNECTED, status: "NEEDS_RECONNECT" });

		renderWithClient(<ChatgptPlanSettings />);

		const reconnect = await screen.findByTestId("chatgpt-plan-reconnect");
		expect(reconnect).toHaveTextContent(copy.reconnectTitle);
		expect(reconnect).toHaveTextContent("fabric connect chatgpt");
		expect(reconnect).toHaveTextContent(copy.reconnectDescription);
		expect(screen.getByText(copy.statusNeedsReconnect)).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: copy.useOrganizationBilling }),
		);
		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled: false,
			}),
		);
	});

	it("hides the toggle when the organization does not allow a plan", async () => {
		status.mockResolvedValue({ ...CONNECTED, currentOrganization: null });

		renderWithClient(<ChatgptPlanSettings />);

		await screen.findByTestId("chatgpt-plan-email");
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});

	it("hides the toggle while the session still points at another organization", async () => {
		status.mockResolvedValue({
			...CONNECTED,
			currentOrganization: {
				...(CONNECTED.currentOrganization as NonNullable<
					Status["currentOrganization"]
				>),
				slug: "other-example-org",
			},
		});

		renderWithClient(<ChatgptPlanSettings />);

		await screen.findByTestId("chatgpt-plan-email");
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});
});

describe("ChatGPT plan prompt", () => {
	const UNANSWERED: Status = {
		...CONNECTED,
		currentOrganization: {
			slug: "example-org",
			name: "Example Org",
			enabled: false,
			answered: false,
		},
	};

	it("does not fetch or render while the flag is off", async () => {
		flag.current = false;
		status.mockResolvedValue(UNANSWERED);

		const { container } = renderWithClient(<ChatgptPlanPrompt />);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.firstChild).toBeNull();
		expect(status).not.toHaveBeenCalled();
	});

	it.each([
		["the member already answered", { ...CONNECTED }],
		["no plan is connected", { ...NOT_CONNECTED }],
		[
			"the plan needs reconnecting",
			{ ...UNANSWERED, status: "NEEDS_RECONNECT" as const },
		],
		[
			"the organization does not allow a plan",
			{ ...UNANSWERED, currentOrganization: null },
		],
	])("stays hidden when %s", async (_label, value) => {
		status.mockResolvedValue(value);

		const { container } = renderWithClient(<ChatgptPlanPrompt />);

		await waitFor(() => expect(status).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.firstChild).toBeNull();
	});

	it.each([
		[copy.prompt.turnOn, true],
		[copy.prompt.notNow, false],
	])("records %s as enabled=%s", async (label, enabled) => {
		status.mockResolvedValue(UNANSWERED);

		renderWithClient(<ChatgptPlanPrompt />);

		expect(await screen.findByText(copy.prompt.title)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: label }));

		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled,
			}),
		);
	});
});

describe("ChatGPT plan reconnect notice", () => {
	const NEEDS_RECONNECT = {
		...CONNECTED,
		status: "NEEDS_RECONNECT" as const,
	};

	it("shows both ways out while the plan is on here but needs reconnecting", async () => {
		status.mockResolvedValue(NEEDS_RECONNECT);
		renderWithClient(<ChatgptPlanReconnectNotice />);

		const notice = await screen.findByTestId(
			"chatgpt-plan-reconnect-notice",
		);
		expect(notice).toHaveTextContent(copy.reconnectDescription);
		expect(notice).toHaveTextContent("fabric connect chatgpt");
		expect(
			screen.getByRole("link", { name: copy.openSettings }),
		).toHaveAttribute(
			"href",
			"/app/example-org/settings/account/ai-providers",
		);

		await userEvent.click(
			screen.getByRole("button", { name: copy.useOrganizationBilling }),
		);
		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled: false,
			}),
		);
	});

	it("shows nothing when the plan is not on in this organization", async () => {
		status.mockResolvedValue({
			...NEEDS_RECONNECT,
			currentOrganization: {
				...(CONNECTED.currentOrganization as NonNullable<
					Status["currentOrganization"]
				>),
				enabled: false,
			},
		});
		const { container } = renderWithClient(<ChatgptPlanReconnectNotice />);
		await waitFor(() => expect(status).toHaveBeenCalled());
		expect(
			container.querySelector(
				"[data-testid='chatgpt-plan-reconnect-notice']",
			),
		).toBeNull();
	});

	it("shows nothing for a working plan", async () => {
		status.mockResolvedValue(CONNECTED);
		const { container } = renderWithClient(<ChatgptPlanReconnectNotice />);
		await waitFor(() => expect(status).toHaveBeenCalled());
		expect(
			container.querySelector(
				"[data-testid='chatgpt-plan-reconnect-notice']",
			),
		).toBeNull();
	});
});

// The in-flow shell notices yield on full-bleed pages (a feature, a
// document), so there the same notice floats in the chrome's dock.
describe("ChatGPT plan reconnect notice on a full-bleed page", () => {
	const NEEDS_RECONNECT = {
		...CONNECTED,
		status: "NEEDS_RECONNECT" as const,
	};
	const FEATURE_PAGE = "/app/example-org/projects/project-1/stories/story-1";

	it("shows both ways out in the dock on a feature page", async () => {
		pathname.mockReturnValue(FEATURE_PAGE);
		status.mockResolvedValue(NEEDS_RECONNECT);
		renderWithClient(<ChatgptPlanReconnectDockNotice />);

		const notice = await screen.findByTestId(
			"chatgpt-plan-reconnect-dock-notice",
		);
		expect(notice).toHaveTextContent(copy.reconnectDescription);
		expect(notice).toHaveTextContent("fabric connect chatgpt");
		await userEvent.click(
			screen.getByRole("button", { name: copy.useOrganizationBilling }),
		);
		await waitFor(() =>
			expect(setOrganizationUse).toHaveBeenCalledExactlyOnceWith({
				enabled: false,
			}),
		);
	});

	it("leaves pages with the in-flow notice to it", async () => {
		pathname.mockReturnValue("/app/example-org");
		status.mockResolvedValue(NEEDS_RECONNECT);
		const { container } = renderWithClient(
			<ChatgptPlanReconnectDockNotice />,
		);
		await waitFor(() => expect(status).toHaveBeenCalled());
		expect(
			container.querySelector(
				"[data-testid='chatgpt-plan-reconnect-dock-notice']",
			),
		).toBeNull();
	});

	it("shows nothing on a feature page for a working plan", async () => {
		pathname.mockReturnValue(FEATURE_PAGE);
		status.mockResolvedValue(CONNECTED);
		const { container } = renderWithClient(
			<ChatgptPlanReconnectDockNotice />,
		);
		await waitFor(() => expect(status).toHaveBeenCalled());
		expect(
			container.querySelector(
				"[data-testid='chatgpt-plan-reconnect-dock-notice']",
			),
		).toBeNull();
	});
});
