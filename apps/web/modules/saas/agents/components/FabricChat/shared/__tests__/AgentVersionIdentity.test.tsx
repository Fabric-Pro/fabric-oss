import { orpc } from "@shared/lib/orpc-query-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentVersionIdentity } from "../AgentVersionIdentity";

const get = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agentTemplates: { instances: { get } } },
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id: string) => id,
}));
vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { createGeneralUtils } = await import("@orpc/tanstack-query");
	return {
		orpc: {
			agentTemplates: {
				instances: createGeneralUtils(["agentTemplates", "instances"]),
			},
		},
	};
});
const instance = {
	name: "Example agent",
	id: "instance-one",
	sId: "stable-one",
	organizationId: "example-org",
	version: 1,
	status: "ARCHIVED",
};
function mount(id = "instance-one", org = "example-org") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<AgentVersionIdentity
				name="Example agent"
				instanceId={id}
				organizationId={org}
			/>
		</QueryClientProvider>,
	);
	return {
		...view,
		client,
		change: (nextId: string, nextOrg = org) =>
			view.rerender(
				<QueryClientProvider client={client}>
					<AgentVersionIdentity
						name="Example agent"
						instanceId={nextId}
						organizationId={nextOrg}
					/>
				</QueryClientProvider>,
			),
	};
}
beforeEach(() => {
	get.mockReset();
});
describe("AgentVersionIdentity", () => {
	it("shows the pinned version and a verified newer active version without changing identity", async () => {
		get.mockResolvedValueOnce({ instance }).mockResolvedValueOnce({
			instance: {
				...instance,
				id: "instance-two",
				version: 2,
				status: "ACTIVE",
			},
		});
		mount();
		await screen.findByText(/Example agent · v1/);
		await screen.findByText(/Newer version available/);
		expect(get.mock.calls).toEqual([
			[{ id: "instance-one" }],
			[{ sId: "stable-one" }],
		]);
	});
	it.each([
		null,
		{ ...instance, version: 2, status: "ARCHIVED" },
		{ ...instance, version: 2, sId: "another-stable", status: "ACTIVE" },
		{
			...instance,
			version: 2,
			organizationId: "another-org",
			status: "ACTIVE",
		},
		{ ...instance, status: "ACTIVE" },
	])("fails closed for an unverified newer result %j", async (active) => {
		get.mockResolvedValueOnce({ instance }).mockResolvedValueOnce({
			instance: active,
		});
		mount();
		await screen.findByText(/Example agent · v1/);
		await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(/Newer version available/)).toBeNull();
	});
	it("keeps the pinned version when the active read fails", async () => {
		get.mockResolvedValueOnce({ instance }).mockRejectedValueOnce(
			new Error("Not found"),
		);
		mount();
		await screen.findByText(/Example agent · v1/);
		await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(/Newer version available/)).toBeNull();
	});
	it("does not display metadata from a different organization", async () => {
		get.mockResolvedValue({ instance });
		mount("instance-one", "another-org");
		await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		expect(screen.queryByText(/· v1/)).toBeNull();
	});
	it("does not let a pending old conversation overwrite the new identity", async () => {
		let resolve!: (value: unknown) => void;
		get.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		).mockResolvedValue({
			instance: {
				...instance,
				id: "instance-two",
				version: 2,
				status: "ACTIVE",
			},
		});
		const view = mount();
		view.change("instance-two");
		await screen.findByText(/Example agent · v2/);
		await act(async () => resolve({ instance }));
		expect(screen.queryByText(/· v1/)).toBeNull();
	});
	it("removes a cached newer indicator when its authorized refresh fails", async () => {
		get.mockResolvedValueOnce({ instance }).mockResolvedValueOnce({
			instance: { ...instance, version: 2, status: "ACTIVE" },
		});
		const view = mount();
		await screen.findByText(/Newer version available/);
		get.mockRejectedValueOnce(new Error("Access unavailable"));
		await act(async () => {
			await view.client.invalidateQueries({
				queryKey: [
					...orpc.agentTemplates.instances.key(),
					"chat-agent-active-version",
					"example-org",
					"stable-one",
				],
			});
		});
		await waitFor(() =>
			expect(screen.queryByText(/Newer version available/)).toBeNull(),
		);
		expect(screen.getByText(/Example agent · v1/)).toBeTruthy();
	});
	it("isolates a pending read when the organization changes", async () => {
		let resolve!: (value: unknown) => void;
		get.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		).mockResolvedValue({
			instance: {
				...instance,
				organizationId: "another-org",
				version: 3,
				status: "ACTIVE",
			},
		});
		const view = mount();
		view.change("instance-one", "another-org");
		await screen.findByText(/Example agent · v3/);
		await act(async () => resolve({ instance }));
		expect(screen.queryByText(/· v1/)).toBeNull();
	});
	it("does not query registered agents or models without an instance identity", async () => {
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<AgentVersionIdentity
					name="Model"
					organizationId="example-org"
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByText("Model")).toBeTruthy();
		expect(get).not.toHaveBeenCalled();
	});
	it("refreshes the mounted pinned badge after save invalidates the canonical instance prefix", async () => {
		let activeVersion = 1;
		get.mockImplementation(
			async (input: { id?: string; sId?: string }) => ({
				instance: input.id
					? instance
					: {
							...instance,
							id: "active-instance",
							version: activeVersion,
							status: "ACTIVE",
						},
			}),
		);
		const view = mount();
		await screen.findByText(/Example agent · v1/);
		await waitFor(() => expect(view.client.isFetching()).toBe(0));
		expect(screen.queryByText(/Newer version available/)).toBeNull();
		activeVersion = 2;
		await act(async () => {
			await view.client.invalidateQueries({
				queryKey: orpc.agentTemplates.instances.key(),
			});
		});
		await screen.findByText(/Newer version available \(v2\)/);
		expect(screen.getByText(/Example agent · v1/)).toBeTruthy();
	});

	it("uses the authorized execution instance name without a seeded selection", async () => {
		get.mockResolvedValue({ instance });
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<AgentVersionIdentity
					instanceId="instance-one"
					organizationId="example-org"
				/>
			</QueryClientProvider>,
		);
		await screen.findByText(/Example agent · v1/);
	});
});
