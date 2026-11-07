import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: {} as Record<string, unknown>,
	params: "",
	history: vi.fn(),
	latest: {} as Record<string, unknown>,
	saves: vi.fn(),
	rejectSave: true,
	failReload: false,
	refetch: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "example-user" } }),
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (value: string) => `/app/example-org/${value}`,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(m.params),
	usePathname: () =>
		"/app/example-org/report-templates/instances/example-instance",
}));
vi.mock("sonner", () => ({
	toast: { error: m.toast, success: vi.fn(), info: vi.fn() },
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { reports: { executions: { list: m.history } } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const query = (key: string) => ({
		queryOptions: () => ({ queryKey: [key] }),
	});
	const mutation = (key: string) => ({
		mutationOptions: (options: object) => ({ ...options, key }),
	});
	return {
		orpc: {
			reports: {
				instances: {
					get: query("instance"),
					update: mutation("update"),
					execute: mutation("execute"),
					delete: mutation("delete"),
					cancelExecution: mutation("cancel"),
				},
				templates: { skills: { list: query("skills") } },
			},
			mcp: { configs: { list: query("mcp") } },
			workflows: { integrations: { list: query("integrations") } },
			gitlab: { status: query("gitlab") },
		},
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		data:
			queryKey[0] === "instance"
				? m.instance
				: queryKey[0] === "mcp"
					? []
					: queryKey[0] === "skills"
						? { skills: [] }
						: queryKey[0] === "integrations"
							? { integrations: [] }
							: undefined,
		isLoading: false,
		refetch: m.refetch,
	}),
	useMutation: (options: {
		key?: string;
		onError?: (error: Error & { code: string }) => void;
	}) => ({
		isPending: false,
		data: undefined,
		mutate: (input: unknown) => {
			if (options.key === "update") {
				m.saves(input);
				if (m.rejectSave)
					options.onError?.(
						Object.assign(new Error("Conflict"), {
							code: "CONFLICT",
						}),
					);
			}
		},
	}),
}));
vi.mock("@saas/data-connections/lib/gitlab-status-query", () => ({
	gitlabStatusQueryOptions: () => ({ queryKey: ["gitlab"] }),
}));
vi.mock("../InfoHint", () => ({ InfoHint: () => null }));
vi.mock("../ReportConfigBanner", () => ({ ReportConfigBanner: () => null }));
vi.mock("../ReportReadinessRail", () => ({ ReportReadinessRail: () => null }));
vi.mock("../ReportEvidenceSettings", () => ({
	ReportEvidenceSettings: () => null,
}));
vi.mock("../ArtifactDeliveryHistoryDialog", () => ({
	ArtifactDeliveryHistoryDialog: () => null,
}));
vi.mock("../SendArtifactEmailDialog", () => ({
	SendArtifactEmailDialog: () => null,
}));

import { TemplateInstanceDetail } from "../TemplateInstanceDetail";

beforeEach(() => {
	vi.clearAllMocks();
	m.params = "";
	m.rejectSave = true;
	m.failReload = false;
	m.instance = {
		id: "example-instance",
		organizationId: "example-org",
		version: 1,
		name: "Example report",
		description: "",
		updatedAt: "2026-11-05T10:00:00.000Z",
		createdAt: "2026-11-05T10:00:00.000Z",
		isActive: true,
		scheduleMode: "CUSTOM",
		schedule: {
			frequency: "monthly",
			dayOfWeek: 4,
			dayOfMonth: 17,
			hour: 14,
			minute: 30,
			timezone: "Europe/Berlin",
		},
		connections: {
			mcpBindings: {},
			integrationBindings: {},
			parameterBindings: { "example-source": { project: "old-project" } },
			context: { project: "Old project" },
			promptOverride: "Old task override",
			maxIterations: 21,
		},
		parameterDefaults: { hidden: "Old parameter" },
		fabricConfig: {
			strategy: "old-strategy",
			context: "old-context",
			pattern: "old-pattern",
			enableAutoDetection: false,
			customAiTasks: { brief: "Old task" },
			customSystemPrompt: "Old saved system prompt",
		},
		template: {
			id: "example-template",
			name: "Example template",
			description: null,
			heroEmojis: [],
			templateType: "CUSTOM",
			outputFormat: "MARKDOWN",
			definition: {
				dataSources: [],
				aiAgents: [],
				sections: [],
				userPrompt: "Template task",
			},
			parameters: null,
			connections: null,
			fabricConfig: null,
		},
		executions: [],
		executionCount: 0,
	};
	m.latest = {
		...m.instance,
		name: "Latest report",
		updatedAt: "2026-11-05T11:00:00.000Z",
		connections: {},
		parameterDefaults: null,
		fabricConfig: null,
		schedule: null,
		scheduleMode: "OFF",
	};
	m.refetch.mockImplementation(async () => {
		if (m.failReload) return { isError: true, data: undefined };
		m.instance = m.latest;
		return { isError: false, data: m.latest };
	});
});

async function conflictWithOptionalDraft() {
	const user = userEvent.setup();
	render(
		<TemplateInstanceDetail
			instanceId="example-instance"
			organizationId="example-org"
		/>,
	);
	await user.click(screen.getByRole("button", { name: /AI Configuration/ }));
	const prompt = await screen.findByLabelText("Custom System Prompt");
	await user.clear(prompt);
	await user.type(prompt, "Discard this system prompt");
	await user.click(
		screen.getByRole("button", { name: "Save Changes", exact: true }),
	);
	await screen.findByText("reportSettingsChanged");
	return { user, prompt };
}

describe("report settings discard", () => {
	it.each([null, {}])(
		"clears absent optional settings before an unrelated save can resubmit them (%j)",
		async (latestConfig) => {
			m.latest.fabricConfig = latestConfig;
			const { user, prompt } = await conflictWithOptionalDraft();
			await user.click(
				screen.getByRole("button", {
					name: "reloadReportSettings",
					exact: true,
				}),
			);
			await user.click(
				within(screen.getByRole("alertdialog")).getByRole("button", {
					name: "reloadReportSettings",
					exact: true,
				}),
			);
			await waitFor(() =>
				expect(screen.getByLabelText("Instance Name")).toHaveValue(
					"Latest report",
				),
			);
			expect(prompt).toHaveValue("");
			m.rejectSave = false;
			await user.clear(screen.getByLabelText("Instance Name"));
			await user.type(
				screen.getByLabelText("Instance Name"),
				"Reviewed latest report",
			);
			await user.click(
				screen.getByRole("button", {
					name: "Save Changes",
					exact: true,
				}),
			);
			const sent = m.saves.mock.calls.at(-1)?.[0];
			expect(sent.fabricConfig).toBeUndefined();
			expect(sent.parameterDefaults).toBeUndefined();
			expect(sent.connections).toEqual(
				expect.objectContaining({
					parameterBindings: undefined,
					context: undefined,
					promptOverride: "Template task",
					maxIterations: undefined,
				}),
			);
			expect(sent.expectedUpdatedAt).toEqual(
				new Date("2026-11-05T11:00:00.000Z"),
			);
		},
	);
	it("keeps the optional draft when the latest settings cannot be loaded", async () => {
		const { user, prompt } = await conflictWithOptionalDraft();
		m.failReload = true;
		await user.click(
			screen.getByRole("button", {
				name: "reloadReportSettings",
				exact: true,
			}),
		);
		await user.click(
			within(screen.getByRole("alertdialog")).getByRole("button", {
				name: "reloadReportSettings",
				exact: true,
			}),
		);
		await waitFor(() =>
			expect(m.toast).toHaveBeenCalledWith("reportSettingsReloadFailed"),
		);
		expect(prompt).toHaveValue("Discard this system prompt");
		expect(
			screen.getByRole("button", { name: "Save Changes", exact: true }),
		).toBeEnabled();
		expect(m.saves).toHaveBeenCalledTimes(1);
	});
});

it("pages native history beyond the recent ten and resets its cursor when filtering", async () => {
	m.params = "tab=history";
	const row = (id: string) => ({
		id,
		instanceId: "example-instance",
		userId: "example-user",
		status: "COMPLETED",
		startedAt: "2026-11-05T10:00:00.000Z",
		completedAt: "2026-11-05T10:00:01.000Z",
		createdAt: "2026-11-05T10:00:00.000Z",
		duration: 1000,
		error: null,
		mcpDiagnostics: null,
		artifacts: [],
	});
	m.history
		.mockResolvedValueOnce({
			executions: Array.from({ length: 10 }, (_, i) =>
				row(`example-run-${i}`),
			),
			hasMore: true,
			nextCursor: "example-older-cursor",
		})
		.mockResolvedValueOnce({
			executions: [row("example-run-older")],
			hasMore: false,
			nextCursor: null,
		})
		.mockResolvedValue({
			executions: [],
			hasMore: false,
			nextCursor: null,
		});
	const user = userEvent.setup();
	render(
		<TemplateInstanceDetail
			instanceId="example-instance"
			organizationId="example-org"
		/>,
	);
	await screen.findByText("Page 1 · 10 runs");
	await user.click(screen.getByRole("button", { name: "Next runs" }));
	await screen.findByText("Page 2 · 1 runs");
	expect(m.history).toHaveBeenLastCalledWith({
		instanceId: "example-instance",
		organizationId: "example-org",
		limit: 10,
		cursor: "example-older-cursor",
	});
	expect(screen.getByRole("button", { name: "Next runs" })).toBeDisabled();
	await user.selectOptions(
		screen.getByRole("combobox", { name: "Status" }),
		"FAILED",
	);
	await waitFor(() =>
		expect(m.history).toHaveBeenLastCalledWith({
			instanceId: "example-instance",
			organizationId: "example-org",
			limit: 10,
			cursor: undefined,
			status: "FAILED",
		}),
	);
	expect(
		screen.getByRole("button", { name: "Previous runs" }),
	).toBeDisabled();
});
