import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DecisionReplayDashboard } from "../DecisionReplayDashboard";

const mocks = vi.hoisted(() => {
	let release!: () => void;
	return {
		loaded: new Promise<void>((resolve) => {
			release = resolve;
		}),
		release: () => release(),
		mint: vi.fn(),
		options: vi.fn(),
		destroy: vi.fn(),
	};
});
vi.mock("next-themes", () => ({
	useTheme: () => ({ resolvedTheme: "light" }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			decisionReplay: {
				getEmbedToken: (...args: unknown[]) => mocks.mint(...args),
			},
		},
	},
}));
vi.mock("../decision-replay-dashboard-client", () => ({
	loadReplayDashboard: async () => {
		await mocks.loaded;
		return {
			DatabricksDashboard: class {
				constructor(options: { container: HTMLElement }) {
					mocks.options(options);
					this.container = options.container;
				}
				container: HTMLElement;
				initialize() {
					this.container.append(document.createElement("iframe"));
				}
				destroy() {
					mocks.destroy();
					this.container.replaceChildren();
				}
			},
		};
	},
}));
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
it("a re-create supersedes an earlier showToken waiting for the SDK import", async () => {
	vi.useFakeTimers();
	const result = (token: string, lifetime: number) => ({
		available: true,
		token,
		expiresAt: new Date(Date.now() + lifetime).toISOString(),
		instanceUrl: "https://example.com",
		workspaceId: "example-workspace",
		dashboardId: "example-dashboard",
	});
	mocks.mint
		.mockImplementationOnce(async () =>
			result("initial-example-token", 600000),
		)
		.mockImplementation(async () =>
			result("replacement-example-token", 3600000),
		);
	const view = render(
		<DecisionReplayDashboard projectId="example-project" />,
	);
	await act(async () => {});
	// The earlier token remains valid, so only the sequence guard can discard
	// its pending import when a newer due refresh offers a replacement.
	vi.setSystemTime(Date.now() + 120000);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(240000);
		window.dispatchEvent(new Event("online"));
	});
	expect(mocks.mint).toHaveBeenCalledTimes(2);
	await act(async () => {
		mocks.release();
	});
	expect(mocks.options).toHaveBeenCalledTimes(1);
	expect(mocks.options.mock.lastCall?.[0].token).toBe(
		"replacement-example-token",
	);
	expect(view.container.querySelectorAll("iframe")).toHaveLength(1);
	view.unmount();
	expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
