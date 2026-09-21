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

const { gatesMock, suppressMock, restoreMock } = vi.hoisted(() => ({
	gatesMock: vi.fn(),
	suppressMock: vi.fn(),
	restoreMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		capabilities: {
			gates: gatesMock,
			suppressWarning: suppressMock,
			restoreWarnings: restoreMock,
		},
	},
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
		retry: { supported: false, permitted: false, available: false },
		suppressed: false,
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
				retry: { supported: true, permitted: true, available: true },
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

	it("asks for the whole matrix rather than one surface", () => {
		// Narrowing per surface reads like an optimisation and is the opposite
		// of one: two surfaces on a page would mean two requests.
		serve([]);
		renderGated(<GateProbe />);

		expect(gatesMock).toHaveBeenCalledWith({ projectId: "proj_example" });
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
			stalled({ supported: true, permitted: false, available: true }),
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
			stalled({ supported: true, permitted: false, available: true }),
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
			stalled({ supported: true, permitted: true, available: false }),
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
		serve([stalled({ supported: true, permitted: true, available: true })]);
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
		serve([stalled({ supported: true, permitted: true, available: true })]);
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

	it("never offers the session duration the server refuses", async () => {
		serve([dismissible("WARNING")]);
		renderGated(<CapabilityGateBanner capabilityKey={KEY} />);

		await userEvent.click(await screen.findByLabelText("dismiss.action"));
		// `SNOOZE_DURATIONS` in the API package still lists "session", but the
		// write path throws on it — a menu built from that constant would ship
		// a button that always 400s.
		expect(screen.queryByText(/session/i)).not.toBeInTheDocument();
	});
});
