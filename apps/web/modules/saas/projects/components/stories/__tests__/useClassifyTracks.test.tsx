import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoadmapActionsMenu } from "../RoadmapActionsMenu";
import { useClassifyTracks } from "../useClassifyTracks";

const api = vi.hoisted(() => ({
	start: vi.fn().mockResolvedValue({ workflowId: "example-workflow" }),
	progress: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: async () => ({ isConfigured: true }) },
		},
		projects: {
			stories: {
				classifyTracks: api.start,
				classificationProgress: api.progress,
			},
		},
	},
}));
vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: messages } = await import(
		"@repo/i18n/translations/en.json"
	);
	return {
		...actual,
		useTranslations: (namespace: string) =>
			actual.createTranslator({ locale: "en", messages, namespace }),
	};
});
const storiesKey = ["example-stories"];
function Page() {
	const classify = useClassifyTracks({
		projectId: "example-project",
		storiesQueryKey: storiesKey,
	});
	return (
		<>
			<RoadmapActionsMenu
				items={[]}
				actions={{
					onClassify: classify.start,
					classifyDisabledReason: classify.disabledReason,
					onScan: vi.fn(),
					scanning: false,
					onExport: vi.fn(),
					exporting: false,
					onRefresh: vi.fn(),
					onHistory: vi.fn(),
					onRejected: vi.fn(),
				}}
			/>
			<output>{classify.isRunning ? "Classifying" : "Idle"}</output>
		</>
	);
}
describe("page-mounted classification", () => {
	it("keeps progress polling after selecting the action closes the menu", async () => {
		api.progress
			.mockResolvedValueOnce({ status: "running" })
			.mockResolvedValue({ status: "complete", classified: 2 });
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={client}>
				<Page />
			</QueryClientProvider>,
		);
		await user.click(screen.getByRole("button", { name: "Actions" }));
		const action = screen.getByRole("menuitem", {
			name: /^Classify delivery tracks/,
		});
		await waitFor(() =>
			expect(action).not.toHaveAttribute("aria-disabled"),
		);
		await user.click(action);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("Classifying"),
		);
		await waitFor(() => expect(api.progress).toHaveBeenCalledTimes(2), {
			timeout: 6000,
		});
		expect(api.progress).toHaveBeenLastCalledWith({
			projectId: "example-project",
			organizationId: "example-org",
			workflowId: "example-workflow",
		});
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("Idle"),
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: storiesKey });
	}, 8000);
});
