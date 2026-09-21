import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which scanners are enabled decides whether a scan needs a codebase at all, so
 * saving this card can flip the `security.run-scan` capability gate in either
 * direction (Fizzy #1930).
 *
 * The gate query lives in a provider mounted on the project layout. Saving here
 * neither remounts it nor touches its cache, so without an explicit refresh the
 * banner and the disabled Scan button answer from the pre-save state for the
 * rest of the session — observed on staging 2026-09-21: turning a repository
 * scanner on left Scan pressable with no explanation, turning it back off left
 * the block in place, and only a full reload corrected either.
 */

const refetchGates = vi.fn();

vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	() => ({
		useCapabilityGates: () => ({ refetch: refetchGates }),
	}),
);

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const updateMutationFn = vi.fn(async () => ({ ok: true }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			scan: {
				config: {
					get: {
						queryOptions: ({
							input,
						}: {
							input: Record<string, unknown>;
						}) => ({
							queryKey: ["scan-config", input],
							queryFn: async () => ({ config: null }),
						}),
						queryKey: ({
							input,
						}: {
							input: Record<string, unknown>;
						}) => ["scan-config", input],
					},
					update: {
						mutationOptions: (
							options: Record<string, unknown>,
						) => ({
							...options,
							mutationFn: updateMutationFn,
						}),
					},
				},
			},
		},
	},
}));

import { ScanConfigCard } from "../ScanConfigCard";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
	refetchGates.mockReset();
	updateMutationFn.mockClear();
});

function renderCard() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ScanConfigCard projectId="project-1" organizationId="org-1" />
		</QueryClientProvider>,
	);
}

describe("ScanConfigCard — capability gate refresh", () => {
	it("refreshes the capability gates after the configuration is saved", async () => {
		const user = userEvent.setup();
		renderCard();

		// Any change is enough to enable Save; the repository scanners are the
		// ones that actually move the gate, so use one of those.
		await user.click(
			await screen.findByRole("switch", {
				name: /Semgrep repository code scanning/i,
			}),
		);
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(updateMutationFn).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(refetchGates).toHaveBeenCalledTimes(1));
	});

	it("does not refresh the gates before anything is saved", async () => {
		const user = userEvent.setup();
		renderCard();

		await user.click(
			await screen.findByRole("switch", {
				name: /Semgrep repository code scanning/i,
			}),
		);

		expect(refetchGates).not.toHaveBeenCalled();
	});
});
