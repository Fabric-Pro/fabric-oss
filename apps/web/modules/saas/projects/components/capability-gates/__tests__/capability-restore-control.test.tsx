/**
 * The way back from a dismissed warning (Fizzy #1930, FR32 / AC-8).
 *
 * The behaviour worth pinning is that a dismissal is never one-way: the control
 * appears exactly when there is something to undo, restores only what its host
 * covers, and confirms itself to a screen reader once the warnings are actually
 * back rather than the moment the button is pressed.
 */

import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRestoreControl } from "../CapabilityRestoreControl";
import {
	CapabilityGatesProvider,
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

/** A dismissed warning on the given capability. */
function suppressedGate(
	capabilityKey: string,
	reasonKey: string,
): CapabilityGate {
	return {
		capabilityKey,
		state: "WARNING",
		reasonKey,
		blockingDependency: "project context",
		remedy: "ADD_CONTEXT",
		retry: { supported: false, permitted: false, available: false },
		suppressed: true,
	};
}

function serve(gates: CapabilityGate[], enabled = true) {
	gatesMock.mockResolvedValue({ enabled, gates });
}

function GateProbe() {
	const { isLoading, enabled } = useCapabilityGates();
	return (
		<span data-testid="probe">
			{isLoading ? "loading" : enabled ? "resolved-on" : "resolved-off"}
		</span>
	);
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

beforeEach(() => {
	gatesMock.mockReset();
	suppressMock.mockReset();
	restoreMock.mockReset();
	suppressMock.mockResolvedValue({ suppressed: true });
	restoreMock.mockResolvedValue({ restored: true });
});

describe("nothing dismissed means nothing on the page", () => {
	it("renders no element at all when the count is zero", async () => {
		serve([
			{
				...suppressedGate("documents.generate-prd", "context.thin"),
				suppressed: false,
			},
		]);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityRestoreControl />
			</>,
		);

		await screen.findByText("resolved-on");
		// Not an empty wrapper — the same standard the flag-off tests hold the
		// banner and the action to.
		expect(container.querySelectorAll("div")).toHaveLength(0);
		expect(
			screen.queryByRole("button", { name: /restore\.action/ }),
		).not.toBeInTheDocument();
	});

	it("renders nothing when the flag is off", async () => {
		serve([], false);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityRestoreControl />
			</>,
		);

		await screen.findByText("resolved-off");
		expect(container.querySelectorAll("div")).toHaveLength(0);
	});

	it("renders nothing when every dismissal is outside its scope", async () => {
		serve([suppressedGate("atlas.explore", "codebase.index-stale")]);
		const { container } = renderGated(
			<>
				<GateProbe />
				<CapabilityRestoreControl
					capabilityKeys={["documents.generate-prd"]}
				/>
			</>,
		);

		await screen.findByText("resolved-on");
		expect(container.querySelectorAll("div")).toHaveLength(0);
	});
});

describe("something dismissed means a way back", () => {
	it("appears with a count once a warning is silenced", async () => {
		serve([suppressedGate("documents.generate-prd", "context.thin")]);
		renderGated(<CapabilityRestoreControl />);

		const button = await screen.findByRole("button", {
			name: /restore\.action/,
		});
		expect(button).toBeEnabled();
		const count = screen.getByText("restore.count");
		// Same judgement as the disabled retry control: the supporting detail is
		// adjacent text tied to the control, not a hover-only tooltip.
		expect(button).toHaveAttribute("aria-describedby", count.id);
	});

	it("is reachable and operable from the keyboard", async () => {
		serve([suppressedGate("documents.generate-prd", "context.thin")]);
		renderGated(<CapabilityRestoreControl />);

		const button = await screen.findByRole("button", {
			name: /restore\.action/,
		});
		await userEvent.tab();
		expect(button).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(restoreMock).toHaveBeenCalled());
	});

	it("restores the whole project when it covers the whole project", async () => {
		serve([
			suppressedGate("documents.generate-prd", "context.thin"),
			suppressedGate("atlas.explore", "codebase.index-stale"),
		]);
		renderGated(<CapabilityRestoreControl />);

		await userEvent.click(
			await screen.findByRole("button", { name: /restore\.action/ }),
		);

		// One call, no per-warning targeting: the viewer asked for everything.
		await waitFor(() =>
			expect(restoreMock).toHaveBeenCalledWith({
				projectId: "proj_example",
			}),
		);
		expect(restoreMock).toHaveBeenCalledTimes(1);
	});

	it("restores only its own scope, leaving other surfaces dismissed", async () => {
		serve([
			suppressedGate("documents.generate-prd", "context.thin"),
			suppressedGate("atlas.explore", "codebase.index-stale"),
		]);
		renderGated(
			<CapabilityRestoreControl
				capabilityKeys={["documents.generate-prd"]}
			/>,
		);

		await userEvent.click(
			await screen.findByRole("button", { name: /restore\.action/ }),
		);

		// Someone clicking this above their documents has not asked to undo a
		// dismissal they made on the Atlas tab.
		await waitFor(() =>
			expect(restoreMock).toHaveBeenCalledWith({
				projectId: "proj_example",
				capabilityKey: "documents.generate-prd",
				reasonKey: "context.thin",
			}),
		);
		expect(restoreMock).toHaveBeenCalledTimes(1);
		expect(restoreMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ capabilityKey: "atlas.explore" }),
		);
	});
});

describe("the confirmation tells the truth", () => {
	it("announces only once the warnings are actually back", async () => {
		const suppressed = suppressedGate(
			"documents.generate-prd",
			"context.thin",
		);
		gatesMock.mockResolvedValueOnce({ enabled: true, gates: [suppressed] });
		// The refetch after the restore sees the warning un-suppressed.
		gatesMock.mockResolvedValue({
			enabled: true,
			gates: [{ ...suppressed, suppressed: false }],
		});

		renderGated(<CapabilityRestoreControl />);

		const button = await screen.findByRole("button", {
			name: /restore\.action/,
		});
		// The live region exists before the message lands in it — a region
		// inserted together with its text is announced unreliably.
		const region = document.querySelector('[aria-live="polite"]');
		expect(region).toBeInTheDocument();
		expect(region).toHaveTextContent("");

		await userEvent.click(button);

		expect(await screen.findByText("restore.done")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /restore\.action/ }),
		).not.toBeInTheDocument();
	});

	it("stays silent when the restore did not take", async () => {
		// The warning is still suppressed after the refetch, so nothing was
		// undone — announcing success here would be a lie to the one user who
		// cannot see that the warnings never came back.
		serve([suppressedGate("documents.generate-prd", "context.thin")]);
		restoreMock.mockRejectedValue(new Error("nope"));

		renderGated(<CapabilityRestoreControl />);
		await userEvent.click(
			await screen.findByRole("button", { name: /restore\.action/ }),
		);

		await waitFor(() => expect(restoreMock).toHaveBeenCalled());
		expect(screen.queryByText("restore.done")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /restore\.action/ }),
		).toBeInTheDocument();
	});
});
