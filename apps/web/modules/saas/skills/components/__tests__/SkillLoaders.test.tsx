import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { skill } from "./fixtures";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { skills: { get: h.get } },
}));
vi.mock("../SkillEditor", () => ({
	SkillEditor: () => <p>Authorized editor loaded</p>,
}));
vi.mock("../SkillViewer", () => ({
	SkillViewer: () => <p>Authorized details loaded</p>,
}));

import { SkillEditLoader } from "../SkillEditLoader";
import { SkillNewLoader } from "../SkillNewLoader";
import { SkillViewLoader } from "../SkillViewLoader";

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
const loaders = [
	() => <SkillViewLoader skillId={skill.id} />,
	() => <SkillEditLoader skillId={skill.id} />,
	() => <SkillNewLoader sourceSkillId={skill.id} />,
];
beforeEach(() => {
	vi.clearAllMocks();
});
it.each(loaders)(
	"retries a transient authorized read only after the user chooses Retry",
	async (loader) => {
		h.get
			.mockRejectedValueOnce(new Error("Temporary connection failure"))
			.mockResolvedValue({ skill });
		const v = render(loader(), { wrapper });
		fireEvent.click(
			await v.findByRole("button", { name: "Retry", exact: true }),
		);
		await v.findByText(/Authorized (editor|details) loaded/);
		expect(h.get).toHaveBeenCalledTimes(2);
		expect(h.get).toHaveBeenLastCalledWith({
			id: skill.id,
			organizationId: "example-org",
		});
	},
);
it.each(
	loaders.flatMap((loader) =>
		["FORBIDDEN", "NOT_FOUND"].map((code) => ({ loader, code })),
	),
)("does not invite retries for $code reads", async ({ loader, code }) => {
	h.get.mockRejectedValue(Object.assign(new Error("Unavailable"), { code }));
	const v = render(loader(), { wrapper });
	await v.findByRole("alert");
	expect(
		v.queryByRole("button", { name: "Retry", exact: true }),
	).not.toBeInTheDocument();
	expect(h.get).toHaveBeenCalledTimes(1);
});
