import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	change: vi.fn(),
	userId: "example-user",
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: m.userId } }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { reports: { branding: { get: m.get } } },
}));

import { ReportBrandingSettings } from "../ReportBrandingSettings";

const company = {
	version: 2,
	name: "Example company",
	hasPalette: true,
	primaryColor: "#334155",
	accentColors: [],
	displayFontFamily: "Poppins",
	bodyFontFamily: "Inter",
	coverStyle: "DARK",
};
const client = {
	...company,
	version: 8,
	name: "Example client",
	primaryColor: "#0f766e",
	coverStyle: "LIGHT",
};
function setup(
	options: {
		outputFormat?: string;
		value?: { source: "COMPANY" | "CLIENT"; expectedBrandVersion: number };
	} = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const tree = () => (
		<QueryClientProvider client={queryClient}>
			<ReportBrandingSettings
				organizationId="example-org"
				projectId="example-project"
				outputFormat={options.outputFormat ?? "MARKDOWN"}
				value={options.value}
				onChange={m.change}
			/>
		</QueryClientProvider>
	);
	const view = render(tree());
	return { ...view, rerenderIdentity: () => view.rerender(tree()) };
}
beforeEach(() => {
	vi.clearAllMocks();
	m.userId = "example-user";
	m.get.mockResolvedValue({ company, client });
});
describe("report brand settings", () => {
	it("keeps legacy reports unbranded and reads choices only when deliberately opened", async () => {
		const user = userEvent.setup();
		setup();
		expect(m.get).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "review" }));
		await screen.findByText("Example client");
		await user.click(screen.getByRole("radio", { name: "source.CLIENT" }));
		expect(m.change).not.toHaveBeenCalled();
		await user.click(
			screen.getByRole("button", { name: "useReviewedTheme" }),
		);
		expect(m.change).toHaveBeenCalledWith({
			source: "CLIENT",
			expectedBrandVersion: 8,
		});
	});
	it("requires explicit re-review when the saved brand version changed", async () => {
		const user = userEvent.setup();
		setup({ value: { source: "CLIENT", expectedBrandVersion: 7 } });
		await user.click(screen.getByRole("button", { name: "review" }));
		await screen.findByText("reportBrandChanged");
		expect(m.change).not.toHaveBeenCalled();
		await user.click(
			screen.getByRole("button", { name: "useReviewedTheme" }),
		);
		expect(m.change).toHaveBeenCalledWith({
			source: "CLIENT",
			expectedBrandVersion: 8,
		});
	});
	it("does not offer branding for Evidence-only output", () => {
		setup({ outputFormat: "EVIDENCE_EMBED" });
		expect(screen.getByText("reportFormatRequired")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "review" })).toBeDisabled();
		expect(m.get).not.toHaveBeenCalled();
	});
	it("keeps inaccessible branding hidden after an actor switch", async () => {
		const user = userEvent.setup();
		const view = setup();
		await user.click(screen.getByRole("button", { name: "review" }));
		await screen.findByText("Example client");
		m.userId = "example-user-b";
		m.get.mockRejectedValue(new Error("private detail"));
		view.rerenderIdentity();
		expect(screen.queryByText("Example client")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText("loadFailed")).toBeInTheDocument(),
		);
		expect(m.change).not.toHaveBeenCalled();
	});
});

it.each(["PDF", "MULTI_FORMAT"])(
	"offers deliberate saved-brand review for %s",
	async (outputFormat) => {
		const user = userEvent.setup();
		setup({ outputFormat });
		expect(screen.getByRole("button", { name: "review" })).toBeEnabled();
		expect(m.get).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "review" }));
		await screen.findByText("Example client");
		expect(m.change).not.toHaveBeenCalled();
	},
);
