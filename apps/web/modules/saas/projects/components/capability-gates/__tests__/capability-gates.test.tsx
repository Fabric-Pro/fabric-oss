/**
 * The banner and the hook against the real provider (Fizzy #1930).
 *
 * `next-intl` is echoed globally by `vitest.setup.ts`, so a rendered string here
 * IS the translation key the component chose. Asserting on those keys is
 * deliberate — see the note in `capability-gate-view.test.ts`.
 *
 * The verdict a surface acts on (`blocked`) is asserted through a probe rather
 * than a component, because no component consumes it: every surface wired so far
 * already owns its own button and folds `blocked` into the `disabled` it already
 * had. `mount-security` and `mount-documents` cover that seam on the real pages.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityGateBanner } from "../CapabilityGateBanner";
import {
	CapabilityGatesProvider,
	useCapabilityGate,
	useCapabilityGates,
} from "../useCapabilityGates";

const { gatesMock, suppressMock, restoreMock, reindexMock, navigateMock } =
	vi.hoisted(() => ({
		gatesMock: vi.fn(),
		suppressMock: vi.fn(),
		restoreMock: vi.fn(),
		reindexMock: vi.fn(),
		navigateMock: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		capabilities: {
			gates: gatesMock,
			suppressWarning: suppressMock,
			restoreWarnings: restoreMock,
		},
		projects: { repositoryIntegrations: { reindex: reindexMock } },
	},
}));

vi.mock("../../settings-tab-navigation", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../settings-tab-navigation")>()),
	navigateToProjectSettingsTab: navigateMock,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

const KEY = "atlas.explore";

function gate(overrides: Partial<CapabilityGate> = {}): CapabilityGate {
	return {
		capabilityKey: KEY,
		state: "AVAILABLE",
		reasonKey: null,
		blockingDependency: null,
		remedy: null,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
		suppressed: false,
		fingerprint: "fingerprint_example",
		...overrides,
	};
}

/** The server's answer for this render. */
function serve(gates: CapabilityGate[], enabled = true) {
	gatesMock.mockResolvedValue({ enabled, gates });
}

function renderGated(ui: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<CapabilityGatesProvider projectId="proj_example">
				{ui}
			</CapabilityGatesProvider>
		</QueryClientProvider>,
	);
}

/**
 * Makes the resolved state observable.
 *
 * Several assertions below are about something NOT being on the page, and the
 * loading pass looks identical to the answer they are checking for — waiting on
 * the mock having been called only proves the request went out, not that it came
 * back. Every such test waits on this first.
 */
function GateProbe({ capabilityKey = KEY }: { capabilityKey?: string }) {
	const { isLoading, enabled } = useCapabilityGates();
	const { blocked } = useCapabilityGate(capabilityKey);
	return (
		<span data-testid="probe">
			{isLoading ? "loading" : enabled ? "resolved-on" : "resolved-off"}
			{blocked ? " blocked" : " unblocked"}
		</span>
	);
}

beforeEach(() => {
	gatesMock.mockReset();
	suppressMock.mockReset();
	restoreMock.mockReset();
	reindexMock.mockReset();
	navigateMock.mockReset();
	window.sessionStorage.clear();
	reindexMock.mockResolvedValue({ success: true, started: 1 });
	suppressMock.mockResolvedValue({ suppressed: true });
	restoreMock.mockResolvedValue({ restored: true });
});

describe("the flag being off changes nothing on the page", () => {
	it("renders no banner and blocks nothing", async () => {
		serve([], false);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityGateBanner capabilityKey={KEY} />
			</>,
		);

		await screen.findByText(/resolved-off unblocked/);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		// Not an empty wrapper either — an empty element carrying padding is the
		// classic way "renders nothing" quietly stops being pixel-identical.
		expect(container.querySelectorAll("div")).toHaveLength(0);
	});
});

describe("what renders nothing", () => {
	it("leaves an available capability completely untouched", async () => {
		serve([gate({ state: "AVAILABLE" })]);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityGateBanner capabilityKey={KEY} />
			</>,
		);

		await screen.findByText(/resolved-on unblocked/);
		expect(container.querySelectorAll("div")).toHaveLength(0);
	});

	it("renders no banner for a hidden capability", async () => {
		// `HIDDEN` should remove the action from the page altogether, which no
		// surface implements and no rule emits — so today it behaves as
		// available. Pinned so the behaviour is characterised rather than
		// assumed; see the note in `capability-gate-view.ts`.
		serve([gate({ state: "HIDDEN" })]);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityGateBanner capabilityKey={KEY} />
			</>,
		);

		await screen.findByText(/resolved-on unblocked/);
		expect(container.querySelectorAll("div")).toHaveLength(0);
	});

	it("hides a warning this viewer already dismissed", async () => {
		serve([
			gate({
				state: "WARNING",
				reasonKey: "codebase.index-stale",
				blockingDependency: "the most recent indexing run",
				remedy: "RETRY_JOB",
				retry: {
					supported: true,
					permitted: true,
					available: true,
					targetId: null,
				},
				suppressed: true,
			}),
		]);
		renderGated(
			<>
				<GateProbe />
				<CapabilityGateBanner capabilityKey={KEY} />
			</>,
		);

		await screen.findByText(/resolved-on/);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("blocks nothing while the gate is still loading", () => {
		// A gate that defaulted to blocking would grey out working buttons for
		// the width of a request on every single page load.
		gatesMock.mockReturnValue(new Promise(() => {}));
		renderGated(<GateProbe />);

		expect(screen.getByTestId("probe")).toHaveTextContent(
			"loading unblocked",
		);
	});
});

describe("one resolution per page", () => {
	it("fetches once however many gated components are on screen", async () => {
		serve([gate({ state: "AVAILABLE" })]);
		renderGated(
			<>
				<GateProbe />
				<GateProbe capabilityKey="security.run-scan" />
				<CapabilityGateBanner capabilityKey={KEY} />
				<CapabilityGateBanner capabilityKey="security.run-scan" />
			</>,
		);

		await waitFor(() => expect(gatesMock).toHaveBeenCalled());
		expect(gatesMock).toHaveBeenCalledTimes(1);
	});

	it("asks, in one request, for exactly the surfaces a page mounts", () => {
		// Rewritten in the Fizzy #1930 review round. This used to pin the
		// whole-matrix read, and the whole matrix included the Atlas gates —
		// whose resolution calls the git provider, may refresh a credential and
		// can write an audit row — on every page load and after every mutation,
		// for gates no page renders.
		serve([]);
		renderGated(<GateProbe />);

		expect(gatesMock).toHaveBeenCalledTimes(1);
		expect(gatesMock).toHaveBeenCalledWith({
			projectId: "proj_example",
			surfaces: ["documents", "context", "security", "release-notes"],
		});
	});

	it("fails loudly in development when a gated component has no provider", () => {
		// Development only, and deliberately so: the suites for every gated page
		// mock react-query wholesale, so a provider cannot run inside them and a
		// throw under test would make gating a surface prohibitively expensive.
		// `vitest.setup.ts` pins NODE_ENV to "test", so this reaches for the one
		// environment the guard is written for.
		vi.stubEnv("NODE_ENV", "development");
		try {
			expect(() =>
				render(<CapabilityGateBanner capabilityKey={KEY} />),
			).toThrow(/CapabilityGatesProvider/);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("degrades to ungated under test rather than throwing", () => {
		// The reversal that lets an existing page suite keep passing unchanged
		// while the page itself is gated. Nothing renders, nothing is disabled.
		const { container } = render(
			<CapabilityGateBanner capabilityKey={KEY} />,
		);
		expect(container.innerHTML).toBe("");
	});
});

describe("retry is disabled, never hidden, when the viewer may not run it", () => {
	const stalled = (retry: CapabilityGate["retry"]) =>
		gate({
			state: "HARD_BLOCK",
			reasonKey: "codebase.indexing-stalled",
			blockingDependency: "indexing for Atlas",
			remedy: "RETRY_JOB",
			retry,
		});

	it("shows a disabled retry and points at a project admin", async () => {
		serve([
			stalled({
				supported: true,
				permitted: false,
				available: true,
				targetId: null,
			}),
		]);
		renderGated(
			<CapabilityGateBanner capabilityKey={KEY} onRetry={vi.fn()} />,
		);

		const retry = await screen.findByRole("button", {
			name: /remedy\.retryJob/,
		});
		// Hiding it would make the block look unfixable, which is the opposite
		// of what this feature exists to do.
		expect(retry).toBeInTheDocument();
		expect(retry).toBeDisabled();
		expect(screen.getByText("retry.notPermitted")).toBeInTheDocument();
	});

	it("keeps the reason on the page, not in a tooltip", async () => {
		serve([
			stalled({
				supported: true,
				permitted: false,
				available: true,
				targetId: null,
			}),
		]);
		renderGated(
			<CapabilityGateBanner capabilityKey={KEY} onRetry={vi.fn()} />,
		);

		// A disabled button is out of the tab order, so a hover-only tooltip
		// would put the reason beyond a keyboard user's reach.
		const reason = await screen.findByText("retry.notPermitted");
		const retry = screen.getByRole("button", { name: /remedy\.retryJob/ });
		expect(retry).toHaveAttribute("aria-describedby", reason.id);
	});

	it("disables retry while a run is already in flight", async () => {
		serve([
			stalled({
				supported: true,
				permitted: true,
				available: false,
				targetId: null,
			}),
		]);
		renderGated(
			<CapabilityGateBanner capabilityKey={KEY} onRetry={vi.fn()} />,
		);

		const retry = await screen.findByRole("button", {
			name: /remedy\.retryJob/,
		});
		expect(retry).toBeDisabled();
		expect(screen.getByText("retry.notAvailable")).toBeInTheDocument();
	});

	it("runs the retry when all three affordances hold", async () => {
		const onRetry = vi.fn();
		serve([
			stalled({
				supported: true,
				permitted: true,
				available: true,
				targetId: null,
			}),
		]);
		renderGated(
			<CapabilityGateBanner capabilityKey={KEY} onRetry={onRetry} />,
		);

		const retry = await screen.findByRole("button", {
			name: /remedy\.retryJob/,
		});
		expect(retry).toBeEnabled();
		await userEvent.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("offers no retry when there is no job to re-enqueue", async () => {
		serve([
			gate({
				state: "SOFT_BLOCK",
				reasonKey: "documents.no-technical-source",
				blockingDependency:
					"a PRD, architecture document or indexed codebase",
				remedy: "ADD_CONTEXT",
			}),
		]);
		renderGated(
			<CapabilityGateBanner capabilityKey={KEY} onRetry={vi.fn()} />,
		);

		// The gate has definitely landed once its reason is on screen.
		await screen.findByText("reason.documents.no-technical-source.body");
		expect(
			screen.queryByRole("button", { name: /remedy\.retryJob/ }),
		).not.toBeInTheDocument();
	});

	it("offers no retry when the surface supplies no way to run one", async () => {
		// Different from "you may not retry": this page has no retry path at
		// all, so a button with nothing behind it would be worse than none.
		serve([
			stalled({
				supported: true,
				permitted: true,
				available: true,
				targetId: null,
			}),
		]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		await screen.findByText("reason.codebase.indexing-stalled.body");
		expect(
			screen.queryByRole("button", { name: /remedy\.retryJob/ }),
		).not.toBeInTheDocument();
	});
});

describe("an unreachable repository is never told to reconnect", () => {
	it("uses the install-app remedy, not the credential one", async () => {
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.repository-unreachable",
				blockingDependency: "access to the connected repository",
				remedy: "INSTALL_REPOSITORY_APP",
			}),
		]);
		renderGated(
			<CapabilityGateBanner
				capabilityKey={KEY}
				hrefFor={() => "/app/example-org/projects/p/settings"}
			/>,
		);

		expect(
			await screen.findByText("remedy.installRepositoryApp"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("remedy.reconnectCredential"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("reason.codebase.repository-unreachable.body"),
		).toBeInTheDocument();
	});

	it("does send an expired credential to the reconnect flow", async () => {
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.credentials-expired",
				blockingDependency: "valid repository credentials",
				remedy: "RECONNECT_CREDENTIAL",
			}),
		]);
		renderGated(
			<CapabilityGateBanner
				capabilityKey={KEY}
				hrefFor={() => "/app/example-org/projects/p/settings"}
			/>,
		);

		expect(
			await screen.findByText("remedy.reconnectCredential"),
		).toBeInTheDocument();
	});
});

describe("only a warning can be dismissed", () => {
	const dismissible = (state: CapabilityGate["state"]) =>
		gate({
			state,
			reasonKey: "context.thin",
			blockingDependency: "project context",
			remedy: "ADD_CONTEXT",
		});

	it("offers dismissal on a warning", async () => {
		serve([dismissible("WARNING")]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		expect(
			await screen.findByLabelText("dismiss.action"),
		).toBeInTheDocument();
	});

	for (const state of ["HARD_BLOCK", "SOFT_BLOCK", "PROCESSING"] as const) {
		it(`offers no dismissal on ${state}`, async () => {
			serve([dismissible(state)]);
			renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

			// Hiding a block would not make the action work — it would only
			// remove the explanation of why it does not.
			await screen.findByText("reason.context.thin.body");
			expect(
				screen.queryByLabelText("dismiss.action"),
			).not.toBeInTheDocument();
		});
	}

	it("sends the reason exactly as rendered, with the chosen duration", async () => {
		serve([dismissible("WARNING")]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		await userEvent.click(await screen.findByLabelText("dismiss.action"));
		await userEvent.click(await screen.findByText("dismiss.sevenDays"));

		await waitFor(() =>
			expect(suppressMock).toHaveBeenCalledWith({
				projectId: "proj_example",
				capabilityKey: KEY,
				reasonKey: "context.thin",
				duration: "7d",
			}),
		);
	});

	it("offers 'for this session' first, and never sends it to the server", async () => {
		// Rewritten in the Fizzy #1930 review round: this pinned the option's
		// ABSENCE. FR27 asks for it; it is held in sessionStorage and dies with
		// the tab, so it is never a stored row.
		serve([dismissible("WARNING")]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		await userEvent.click(await screen.findByLabelText("dismiss.action"));
		const items = screen.getAllByRole("menuitem");
		expect(items[0]).toHaveTextContent("dismiss.session");

		await userEvent.click(items[0]);

		await waitFor(() =>
			expect(screen.queryByRole("status")).not.toBeInTheDocument(),
		);
		expect(suppressMock).not.toHaveBeenCalled();
		expect(
			window.sessionStorage.getItem(
				"fabric-capability-dismissed:proj_example",
			),
		).toContain(`${KEY}:context.thin:fingerprint_example`);
	});

	it("brings a session dismissal back when the gate's facts change", async () => {
		window.sessionStorage.setItem(
			"fabric-capability-dismissed:proj_example",
			JSON.stringify([`${KEY}:context.thin:an_older_fingerprint`]),
		);
		serve([dismissible("WARNING")]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		expect(await screen.findByRole("status")).toBeInTheDocument();
	});
});

describe("remedies and retries every banner offers on its own (Fizzy #1930)", () => {
	it("renders 'Connect a repository' and sends the viewer to the repository settings", async () => {
		// No mount has to supply this. Before, Security supplied nothing and the
		// button never rendered anywhere.
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.not-connected",
				blockingDependency: "a connected repository",
				remedy: "CONNECT_REPOSITORY",
			}),
		]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		await userEvent.click(
			await screen.findByRole("button", {
				name: "remedy.connectRepository",
			}),
		);
		expect(navigateMock).toHaveBeenCalledWith(
			"proj_example",
			"development",
			{
				anchorId: "project-repository-settings",
			},
		);
	});

	it("sends 'Turn on code search' to the code-search toggle itself", async () => {
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.code-search-off",
				blockingDependency: "code search for this project",
				remedy: "ENABLE_CODE_SEARCH",
			}),
		]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		expect(
			await screen.findByText("reason.codebase.code-search-off.title"),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "remedy.enableCodeSearch" }),
		);
		expect(navigateMock).toHaveBeenCalledWith(
			"proj_example",
			"development",
			{
				anchorId: "project-code-search-settings",
			},
		);
	});

	it("re-indexes exactly the repository the gate names", async () => {
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.never-indexed",
				blockingDependency: "a completed index of the repository",
				remedy: "RETRY_JOB",
				retry: {
					supported: true,
					permitted: true,
					available: true,
					targetId: "integration_broken",
				},
			}),
		]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		// Nothing ran before, so the button starts the first run.
		await userEvent.click(
			await screen.findByRole("button", { name: "remedy.startIndexing" }),
		);
		await waitFor(() =>
			expect(reindexMock).toHaveBeenCalledWith({
				projectId: "proj_example",
				integrationId: "integration_broken",
				mode: "full",
			}),
		);
	});

	it("shows the codebase retry disabled for a viewer who may not re-index", async () => {
		serve([
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.indexing-failed",
				blockingDependency: "a completed index of the repository",
				remedy: "RETRY_JOB",
				retry: {
					supported: true,
					permitted: false,
					available: true,
					targetId: "integration_broken",
				},
			}),
		]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		expect(
			await screen.findByRole("button", { name: /remedy\.retryJob/ }),
		).toBeDisabled();
		expect(screen.getByText("retry.notPermitted")).toBeInTheDocument();
	});
});

describe("a gate that is Processing refreshes itself", () => {
	it("re-reads while something is running, and stops once it is not", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			gatesMock
				.mockResolvedValueOnce({
					enabled: true,
					gates: [
						gate({
							state: "PROCESSING",
							reasonKey: "codebase.indexing",
							blockingDependency: "repository indexing",
							remedy: "WAIT",
						}),
					],
				})
				.mockResolvedValue({ enabled: true, gates: [gate()] });
			renderGated(<GateProbe />);

			await screen.findByText(/resolved-on blocked/);
			await vi.advanceTimersByTimeAsync(5_000);
			await screen.findByText(/resolved-on unblocked/);
			const calls = gatesMock.mock.calls.length;

			await vi.advanceTimersByTimeAsync(20_000);
			expect(gatesMock.mock.calls.length).toBe(calls);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a session dismissal is honoured from the very first paint", () => {
	it("never renders a session-dismissed warning, even from a warm cache", () => {
		window.sessionStorage.setItem(
			"fabric-capability-dismissed:proj_example",
			JSON.stringify([`${KEY}:context.thin:fingerprint_example`]),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// The answer is already cached, so the first render has the gate.
		queryClient.setQueryData(
			["capability-gates", "proj_example", "org_example"],
			{
				enabled: true,
				gates: [
					gate({
						state: "WARNING",
						reasonKey: "context.thin",
						blockingDependency: "project context",
						remedy: "ADD_CONTEXT",
					}),
				],
			},
		);
		gatesMock.mockReturnValue(new Promise(() => {}));

		render(
			<QueryClientProvider client={queryClient}>
				<CapabilityGatesProvider projectId="proj_example">
					<CapabilityGateBanner capabilityKey={KEY} />
				</CapabilityGatesProvider>
			</QueryClientProvider>,
		);

		// Asserted synchronously: no effect has run yet.
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
