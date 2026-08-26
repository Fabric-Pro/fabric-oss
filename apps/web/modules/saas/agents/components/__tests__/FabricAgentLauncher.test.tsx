import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FabricAgentLauncherProvider,
	useFabricAgentLauncher,
	useRegisterFabricAgentContext,
} from "../FabricAgentLauncher";

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/projects/project_1",
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
		// The drawer invalidates the conversation cache when a turn it started
		// finishes, so the full page picks it up after an expand (#2040).
		useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
	};
});

vi.mock("next/dynamic", async () => {
	const React = await import("react");

	function MockDynamicFabricDirectChat({
		initialInput,
		attachedProjectId,
		attachedCodeContext,
	}: {
		initialInput?: string;
		attachedProjectId?: string | null;
		attachedCodeContext?: {
			filePath?: string | null;
			lineStart?: number | null;
			lineEnd?: number | null;
			snippet?: string | null;
		} | null;
	}) {
		const [mockInput, setMockInput] = React.useState(initialInput ?? "");

		React.useEffect(() => {
			setMockInput(initialInput ?? "");
		}, [initialInput]);

		return (
			<div>
				<div>mock direct chat</div>
				<div>initial input: {mockInput}</div>
				<div>attached project: {attachedProjectId ?? ""}</div>
				<div>
					attached code: {attachedCodeContext?.filePath ?? ""}
					{attachedCodeContext?.lineStart
						? `:${attachedCodeContext.lineStart}${
								attachedCodeContext.lineEnd &&
								attachedCodeContext.lineEnd !==
									attachedCodeContext.lineStart
									? `-${attachedCodeContext.lineEnd}`
									: ""
							}`
						: ""}
				</div>
			</div>
		);
	}

	return {
		default: () => MockDynamicFabricDirectChat,
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

afterEach(() => {
	cleanup();
});

function expectLauncherOpen() {
	expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
		"aria-hidden",
		"false",
	);
}

function expectLauncherClosed() {
	expect(screen.getByLabelText("Fabric Agent")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
}

function LauncherHarness() {
	const { openLauncher } = useFabricAgentLauncher();

	return (
		<div>
			<button
				type="button"
				onClick={() =>
					openLauncher({
						projectId: "project_1",
						projectName: "Phoenix",
						storyId: "story_1",
						storyIdentifier: "US-1",
						storyTitle: "Ship the launcher",
						taskId: "task_1",
						taskIdentifier: "TASK-1",
						taskTitle: "Wire shortcut",
						prompt: "Review the launcher context.",
					})
				}
			>
				Open with context
			</button>
			<button
				type="button"
				onClick={() =>
					openLauncher({
						projectId: "project_1",
						projectName: "Phoenix",
						prompt: "Help me understand this module.",
						repositoryUrl: "https://github.com/acme/fabric",
						repositoryOwner: "acme",
						repositoryName: "fabric",
						codeContext: {
							filePath:
								"apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx",
							lineStart: 42,
							lineEnd: 66,
							branch: "main",
							snippet:
								"export function example() { return true; }",
						},
					})
				}
			>
				Open with code context
			</button>
		</div>
	);
}

function AmbientContextHarness() {
	useRegisterFabricAgentContext({
		projectId: "ambient_project",
		projectName: "Ambient Phoenix",
		storyId: "ambient_story",
		storyIdentifier: "US-ambient",
		storyTitle: "Investigate ambient context",
		taskId: "ambient_task",
		taskIdentifier: "TASK-ambient",
		taskTitle: "Open launcher from anywhere",
		prompt: "Use the current workspace context.",
	});

	return <div>ambient context ready</div>;
}

describe("FabricAgentLauncher", () => {
	it("opens from the floating shell trigger", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Fabric Agent/i }));

		expectLauncherOpen();
		expect(screen.getByText("Quick page copilot")).toBeInTheDocument();
		expect(await screen.findByText("mock direct chat")).toBeInTheDocument();
	});

	it("shows visible context chips and prefilled prompt for contextual launches", async () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Open with context/i }),
		);

		expectLauncherOpen();
		expect(await screen.findByText("mock direct chat")).toBeInTheDocument();
		expect(screen.getByText("Phoenix")).toBeInTheDocument();
		expect(
			screen.getByText("US-1 · Ship the launcher"),
		).toBeInTheDocument();
		expect(screen.getByText("TASK-1 · Wire shortcut")).toBeInTheDocument();
		expect(document.body).toHaveTextContent(
			"initial input: Review the launcher context.",
		);
		expect(document.body).toHaveTextContent("attached project: project_1");
	});

	it("shows repository/code context and richer quick actions for contextual code launches", async () => {
		render(
			<FabricAgentLauncherProvider>
				<LauncherHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: /Open with code context/i }),
		);

		expectLauncherOpen();
		expect(await screen.findByText("mock direct chat")).toBeInTheDocument();
		expect(screen.getByText("acme/fabric")).toBeInTheDocument();
		expect(
			screen.getByText(
				"apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx:42-66",
			),
		).toBeInTheDocument();
		expect(screen.getByText(/attached code:/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Trace dependencies/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Explain architecture/i }),
		).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", { name: /Trace dependencies/i }),
		);

		expect(document.body).toHaveTextContent("Repository: acme/fabric");
		expect(document.body).toHaveTextContent(
			"File: apps/web/modules/saas/agents/components/FabricAgentLauncher.tsx:42-66",
		);
		expect(document.body).toHaveTextContent(
			"Trace the main dependencies, imports, and downstream effects of this code:",
		);
	});

	it("opens from Cmd/Ctrl+J", async () => {
		render(
			<FabricAgentLauncherProvider>
				<div>page content</div>
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, {
			key: "j",
			ctrlKey: true,
		});

		expectLauncherOpen();
		expect(await screen.findByText("mock direct chat")).toBeInTheDocument();
	});

	it("uses ambient workspace context when opened globally from the keyboard shortcut", async () => {
		render(
			<FabricAgentLauncherProvider>
				<AmbientContextHarness />
			</FabricAgentLauncherProvider>,
		);

		fireEvent.keyDown(document, {
			key: "j",
			ctrlKey: true,
		});

		expectLauncherOpen();
		expect(await screen.findByText("Ambient Phoenix")).toBeInTheDocument();
		expect(screen.getByText("Ambient Phoenix")).toBeInTheDocument();
		expect(
			screen.getByText("US-ambient · Investigate ambient context"),
		).toBeInTheDocument();
		expect(
			screen.getByText("TASK-ambient · Open launcher from anywhere"),
		).toBeInTheDocument();
		expect(document.body).toHaveTextContent(
			"initial input: Use the current workspace context.",
		);
	});

	it("does not open from Cmd/Ctrl+J while typing in an input", () => {
		render(
			<FabricAgentLauncherProvider>
				<input aria-label="Title" />
			</FabricAgentLauncherProvider>,
		);

		const input = screen.getByRole("textbox", { name: /Title/i });
		input.focus();

		fireEvent.keyDown(input, {
			key: "j",
			ctrlKey: true,
			bubbles: true,
		});

		expectLauncherClosed();
	});
});
