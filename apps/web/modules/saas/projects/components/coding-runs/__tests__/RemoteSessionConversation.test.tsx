import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isCrossSiteWebUiUrl,
	RemoteSessionConversation,
} from "../RemoteSessionConversation";

const f = vi.hoisted(() => ({
	messages: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: {
			messages: f.messages,
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		messages.projects.remoteAgents[
			key as keyof typeof messages.projects.remoteAgents
		] as string,
}));

function renderConversation(
	props: Partial<Parameters<typeof RemoteSessionConversation>[0]> = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<RemoteSessionConversation
				codingRunId="example-run"
				organizationId="example-org"
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("isCrossSiteWebUiUrl", () => {
	it("treats matching loopback hosts and sibling subdomains on the same scheme as same-site", () => {
		expect(
			isCrossSiteWebUiUrl(
				"http://localhost:19125/?ws=demo",
				"http://localhost:3032",
			),
		).toBe(false);
		expect(
			isCrossSiteWebUiUrl(
				"https://agents.example.com/?ws=demo",
				"https://portal.example.com",
			),
		).toBe(false);
	});

	it("flags mismatched loopback hosts, distinct domains, and mixed schemes as cross-site", () => {
		expect(
			isCrossSiteWebUiUrl(
				"http://127.0.0.1:19125/?ws=demo",
				"http://localhost:3032",
			),
		).toBe(true);
		expect(
			isCrossSiteWebUiUrl(
				"https://agents.other.example/?ws=demo",
				"https://portal.example.com",
			),
		).toBe(true);
		expect(
			isCrossSiteWebUiUrl(
				"http://agents.example.com/?ws=demo",
				"https://portal.example.com",
			),
		).toBe(true);
	});
});

describe("RemoteSessionConversation", () => {
	it("embeds a same-site Server Web UI without showing the cross-site cookie warning", async () => {
		f.messages.mockResolvedValue({
			webUrl: "http://localhost:19125/?ws=portal-demo&route=allSessions/session/sess_1",
			messages: [
				{
					id: "msg_1",
					role: "user",
					content: "Inspect coding run status",
				},
			],
		});

		renderConversation();

		expect(
			await screen.findByText("Inspect coding run status"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByTestId("toggle-embedded-session-webui"));

		expect(
			screen.getByTitle("Fabric Agents Remote Server Web UI"),
		).toHaveAttribute(
			"src",
			"http://localhost:19125/?ws=portal-demo&route=allSessions/session/sess_1",
		);
		expect(
			screen.queryByTestId("cross-site-webui-cookie-note"),
		).not.toBeInTheDocument();
	});

	it("shows the SameSite=Strict explanation when embedding a cross-site Server Web UI", async () => {
		f.messages.mockResolvedValue({
			webUrl: "http://127.0.0.1:19125/?ws=portal-demo&route=allSessions/session/sess_1",
			messages: [],
		});

		renderConversation();

		const toggleBtn = await screen.findByTestId(
			"toggle-embedded-session-webui",
		);
		fireEvent.click(toggleBtn);

		expect(
			screen.getByTestId("cross-site-webui-cookie-note"),
		).toHaveTextContent("SameSite=Strict");
		expect(
			screen.getByRole("link", { name: "Open in browser" }),
		).toHaveAttribute(
			"href",
			"http://127.0.0.1:19125/?ws=portal-demo&route=allSessions/session/sess_1",
		);
	});
});
