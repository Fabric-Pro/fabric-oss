import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
	userId: "example-user-a" as string | null,
	organizationId: "example-org-a" as string | null,
}));
const get = vi.hoisted(() => vi.fn());
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: identity.userId ? { id: identity.userId } : null,
	}),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: identity.organizationId,
		organizationName: "Wrong active company",
	}),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { recipientBrand: { get: (input: unknown) => get(input) } },
	},
}));

import { ProjectRecipientBrandCard } from "@saas/projects/components/ProjectRecipientBrandCard";
import {
	ProposalBrandReadiness,
	useProposalBrandReadiness,
} from "@saas/projects/components/proposal-artifact/ProposalBrandReadiness";
import { recipientBrandQueryKey } from "@saas/projects/hooks/use-recipient-brand-query-identity";

const projectId = "example-project";
const read = {
	companyName: "Example project owner",
	version: 2,
	canEdit: true,
	recipientBrand: {
		name: "Example private client",
		website: null,
		colors: ["#123456"],
		logoUrl: null,
		updatedAt: new Date("2026-11-01T00:00:00Z"),
	},
};
function Readiness() {
	const query = useProposalBrandReadiness(projectId, true);
	const [blocked, setBlocked] = useState(false);
	return (
		<ProposalBrandReadiness
			projectId={projectId}
			query={query}
			value="CLIENT"
			onValueChange={() => {}}
			onDraftStateChange={setBlocked}
			disabled={blocked}
		/>
	);
}
function mount(renderChild: () => React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				retryDelay: 0,
				staleTime: Number.POSITIVE_INFINITY,
			},
		},
	});
	const content = () => (
		<QueryClientProvider client={client}>
			{renderChild()}
		</QueryClientProvider>
	);
	const view = render(content());
	return {
		...view,
		rerenderIdentity: () => view.rerender(content()),
		client,
	};
}
beforeEach(() => {
	identity.userId = "example-user-a";
	identity.organizationId = "example-org-a";
	get.mockReset();
	get.mockResolvedValue(read);
});

describe("recipient brand read identity", () => {
	it("keeps project invalidation prefixes while separating both actor and organization", () => {
		expect(
			recipientBrandQueryKey(
				projectId,
				"example-org-a",
				"example-user-a",
			).slice(0, 2),
		).toEqual(["projectRecipientBrand", projectId]);
		expect(
			recipientBrandQueryKey(
				projectId,
				"example-org-a",
				"example-user-a",
			),
		).not.toEqual(
			recipientBrandQueryKey(
				projectId,
				"example-org-a",
				"example-user-b",
			),
		);
		expect(
			recipientBrandQueryKey(
				projectId,
				"example-org-a",
				"example-user-a",
			),
		).not.toEqual(
			recipientBrandQueryKey(
				projectId,
				"example-org-b",
				"example-user-a",
			),
		);
	});
	it("identifies the preparing company from the authorized project's response, including for invited guests", async () => {
		mount(() => <Readiness />);
		expect(
			await screen.findByText("Example project owner"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Wrong active company"),
		).not.toBeInTheDocument();
	});
	it.each(["actor", "organization"])(
		"never displays a prior %s's cached client when the next read fails",
		async (changed) => {
			const view = mount(() => <Readiness />);
			await screen.findByText("Example private client");
			get.mockRejectedValue(new Error("private permission detail"));
			if (changed === "actor") {
				identity.userId = "example-user-b";
			} else {
				identity.organizationId = "example-org-b";
			}
			view.rerenderIdentity();
			expect(
				screen.queryByText("Example private client"),
			).not.toBeInTheDocument();
			expect(await screen.findByText("loadFailed")).toBeInTheDocument();
			expect(
				screen.queryByText("Example project owner"),
			).not.toBeInTheDocument();
			expect(
				screen.queryByText("private permission detail"),
			).not.toBeInTheDocument();
		},
	);
	it("withholds cached company and client data after the same actor loses read permission", async () => {
		const view = mount(() => <Readiness />);
		await screen.findByText("Example private client");
		get.mockRejectedValue(new Error("forbidden"));
		await act(async () => {
			await view.client.invalidateQueries({
				queryKey: ["projectRecipientBrand", projectId],
			});
		});
		expect(await screen.findByText("loadFailed")).toBeInTheDocument();
		expect(
			screen.queryByText("Example project owner"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Example private client"),
		).not.toBeInTheDocument();
	});
	it("does not query before both the actor and organization are resolved", async () => {
		identity.userId = null;
		mount(() => <Readiness />);
		expect(screen.getByText("loading")).toBeInTheDocument();
		expect(get).not.toHaveBeenCalled();
	});
	it("drops another actor's unsaved client editor when identity changes", async () => {
		const user = userEvent.setup();
		const view = mount(() => (
			<ProjectRecipientBrandCard projectId={projectId} canEdit />
		));
		await user.type(
			await screen.findByLabelText("name", { exact: true }),
			" private draft",
		);
		get.mockRejectedValue(new Error("forbidden"));
		identity.userId = "example-user-b";
		view.rerenderIdentity();
		expect(
			screen.queryByDisplayValue("Example private client private draft"),
		).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText("loadFailed")).toBeInTheDocument(),
		);
	});
});
