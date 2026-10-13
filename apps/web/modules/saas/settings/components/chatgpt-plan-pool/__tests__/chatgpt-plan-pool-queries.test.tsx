/**
 * The pool and plan-model reads act on the SESSION's organization (Fizzy
 * #2770). Right after a switch the URL commits before `setActive` lands, and a
 * read in that gap answered for the previous organization — cached under the
 * new one's key, so the page showed the old organization's shared plans until
 * a reload. Nothing may be fetched until the session names the organization on
 * screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({ get: vi.fn() }));
const models = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: { chatgptPlanPool: pool, chatgptPlanModels: models },
	},
}));

const activeOrg = vi.hoisted(() => ({
	current: {
		activeOrganization: { slug: "example-org" } as { slug: string } | null,
		isSessionOnActiveOrganization: false,
	},
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => activeOrg.current,
}));

import { useChatgptPlanModels } from "../../chatgpt-plan-models/chatgpt-plan-models-queries";
import { useChatgptPlanPool } from "../chatgpt-plan-pool-queries";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	pool.get.mockResolvedValue({ accounts: [] });
	models.get.mockResolvedValue({ tasks: [] });
	activeOrg.current = {
		activeOrganization: { slug: "example-org" },
		isSessionOnActiveOrganization: false,
	};
});

describe("organization-scoped ChatGPT plan reads after a switch", () => {
	it("fetches nothing while the session still names the previous organization, then fetches once it names this one", async () => {
		const { rerender } = renderHook(
			() => ({
				pool: useChatgptPlanPool(),
				models: useChatgptPlanModels(),
			}),
			{ wrapper },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(pool.get).not.toHaveBeenCalled();
		expect(models.get).not.toHaveBeenCalled();

		activeOrg.current = {
			activeOrganization: { slug: "example-org" },
			isSessionOnActiveOrganization: true,
		};
		rerender();

		await waitFor(() => expect(pool.get).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(models.get).toHaveBeenCalledTimes(1));
	});
});
