/**
 * Tests for the rest of what `ConnectCliDialog` offers beside the terminal
 * tools: the editors' install links, the "Other" entry, the group of advanced
 * rows under the steps, and the footer. The terminal steps are pinned in
 * `ConnectCliDialog.steps.test.tsx`, minting and the dismissal guard in
 * `ConnectCliDialog.test.tsx`.
 */

import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clipboardWrite,
	discoveryResponse,
	fetchMock,
	INIT,
	installBrowserStubs,
	OTHER_ORIGIN_DOCUMENT,
	PROJECT_GATEWAY,
	PROJECT_ID,
	REPOSITORY_ROUTE,
	renderHost,
	renderInstructions,
	setupLine,
	setupUser,
} from "./connect-dialog-harness";

vi.mock("@shared/lib/orpc-client", async () => {
	const { createKeyMock } = await import("./connect-dialog-mocks");
	return {
		orpcClient: {
			organizations: {
				apiKeys: {
					create: (input: unknown) => createKeyMock(input),
				},
			},
		},
	};
});

beforeEach(installBrowserStubs);

describe("ConnectCliDialog — VS Code and Cursor", () => {
	it("installs into VS Code from a link, then asks for the browser, for a repository project", async () => {
		const user = setupUser();
		renderInstructions();

		await user.click(await screen.findByRole("tab", { name: "VS Code" }));

		const link = screen.getByTestId("agent-sign-in-vscode");
		const href = link.getAttribute("href") ?? "";
		expect(href).toMatch(/^vscode:mcp\/install\?/);
		// The editor installs for every folder it opens, so the server is
		// named for the project, and points at the project's own gateway.
		expect(
			JSON.parse(
				decodeURIComponent(href.slice("vscode:mcp/install?".length)),
			),
		).toEqual({
			name: "fabric-checkout-rewrite-ewrite",
			type: "http",
			url: PROJECT_GATEWAY,
		});
		expect(link).toHaveTextContent("Add to VS Code");
		const steps = screen.getAllByRole("listitem");
		expect(steps).toHaveLength(2);
		expect(steps[0]).toHaveTextContent("Install the Fabric server");
		expect(steps[0]).toHaveTextContent(
			"VS Code asks you to confirm the server.",
		);
		expect(steps[1]).toHaveTextContent("Approve in your browser");
	});

	it("draws the tool's mark on a chip inside the link", async () => {
		const user = setupUser();
		renderInstructions();

		await user.click(await screen.findByRole("tab", { name: "Cursor" }));

		const link = screen.getByTestId("agent-sign-in-cursor");
		expect(link.querySelector("img")).toHaveAttribute(
			"src",
			"/integrations/Cursor.svg",
		);
		expect(link.querySelector("img")).toHaveAttribute("alt", "");
		expect(link.querySelector("svg")).not.toBeNull();
	});

	it("installs into Cursor from a link and says the same", async () => {
		const user = setupUser();
		renderInstructions();

		await user.click(await screen.findByRole("tab", { name: "Cursor" }));

		const href =
			screen.getByTestId("agent-sign-in-cursor").getAttribute("href") ??
			"";
		expect(href).toMatch(
			/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/,
		);
		const params = new URL(href).searchParams;
		expect(params.get("name")).toBe("fabric-checkout-rewrite-ewrite");
		expect(JSON.parse(atob(params.get("config") ?? ""))).toEqual({
			url: PROJECT_GATEWAY,
		});
		expect(
			screen.getByText(/Cursor asks you to confirm the server\./i),
		).toBeInTheDocument();
	});

	it("does not promise a checkout comparison to an upload project's editor", async () => {
		const user = setupUser();
		renderInstructions({ kind: "upload" });

		await user.click(await screen.findByRole("tab", { name: "VS Code" }));

		expect(screen.queryByText(/pulling stays with you/i)).toBeNull();
		expect(
			screen.getByText(/reads the published instructions over MCP/i),
		).toBeInTheDocument();
	});

	it("says nothing about a checkout on the project purpose", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(await screen.findByRole("tab", { name: "VS Code" }));

		const steps = screen.getAllByRole("listitem");
		expect(steps[1]).toHaveTextContent("A sign-in page opens.");
		expect(steps[1].textContent).not.toMatch(/checkout|published/i);
	});
});

describe("ConnectCliDialog — any other client", () => {
	it("gives the key-free server entry, and says where to save it", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.click(screen.getByRole("tab", { name: "Other" }));

		const entry = await screen.findByTestId("agent-sign-in-portable");
		expect(JSON.parse(entry.textContent ?? "")).toEqual({
			mcpServers: {
				fabric: {
					type: "http",
					url: PROJECT_GATEWAY,
				},
			},
		});
		const steps = screen.getAllByRole("listitem");
		expect(steps[0]).toHaveTextContent("Add the server to your MCP config");
		expect(steps[0]).toHaveTextContent(".mcp.json");
		expect(steps[1]).toHaveTextContent("Approve on first connect");
		expect(steps[1]).toHaveTextContent(
			"Any MCP client with sign-in support asks you to approve it in the browser.",
		);
		await user.click(
			screen.getByRole("button", { name: "Copy the server entry" }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(entry.textContent);
	});

	it("sends a terminal agent to the Claude Code tile, whose steps are the one-line setup", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();
		await user.click(screen.getByRole("tab", { name: "Other" }));

		await user.click(
			await screen.findByRole("button", {
				name: "Use the one-line setup",
			}),
		);

		expect(
			screen.getByRole("tab", { name: "Claude Code" }),
		).toHaveAttribute("aria-selected", "true");
		expect((await setupLine()).textContent).toBe(
			`${INIT} --project ${PROJECT_ID} --tool claude-code`,
		);
	});

	it("carries --base-url into that line when the tarball is not built for this page", async () => {
		fetchMock.mockImplementation(async () =>
			discoveryResponse(200, OTHER_ORIGIN_DOCUMENT),
		);
		const user = setupUser();
		renderInstructions();
		await setupLine();
		await user.click(screen.getByRole("tab", { name: "Other" }));
		await user.click(
			await screen.findByRole("button", {
				name: "Use the one-line setup",
			}),
		);

		expect((await setupLine()).textContent).toContain(
			`--base-url ${window.location.origin}`,
		);
	});

	it("offers no one-line setup when the deployment serves no CLI", async () => {
		const user = setupUser();
		fetchMock.mockImplementation(async () => discoveryResponse(404, {}));
		renderInstructions();
		await screen.findByTestId("agent-sign-in-line-unavailable");

		await user.click(screen.getByRole("tab", { name: "Other" }));

		expect(
			await screen.findByTestId("agent-sign-in-portable"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Use the one-line setup" }),
		).not.toBeInTheDocument();
	});

	it("offers no one-line setup on the project purpose", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(await screen.findByRole("tab", { name: "Other" }));

		expect(
			screen.queryByRole("button", { name: "Use the one-line setup" }),
		).not.toBeInTheDocument();
	});
});

describe("ConnectCliDialog — the advanced group", () => {
	async function openGroup(provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS") {
		const user = setupUser();
		renderInstructions({ ...REPOSITORY_ROUTE, provider });
		const row = await screen.findByTestId("connect-cli-git-credentials");
		return { user, row };
	}

	it("holds the git row and the API-key row in one bordered group, git first", async () => {
		renderInstructions();
		const git = await screen.findByTestId("connect-cli-git-credentials");
		const key = screen.getByTestId("connect-cli-key-alternative");

		expect(git.parentElement).toBe(key.parentElement);
		expect(git.parentElement?.className).toContain("divide-y");
		expect(git.parentElement?.className).toContain("border");
		expect(
			git.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("keeps no gap under a closed row's summary", async () => {
		renderInstructions();
		await setupLine();

		const rows = document.querySelectorAll("details");
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.className).not.toMatch(/(^|\s)space-y-/);
		}
	});

	it("is collapsed, and names the provider's own sign-in for GitHub", async () => {
		const { row } = await openGroup("GITHUB");

		expect(row).not.toHaveAttribute("open");
		expect(
			within(row).getByText("Git can't sign in to the repository"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("connect-cli-git-credentials-command"),
		).toHaveTextContent("gh auth login");
		expect(
			within(row).getByText(/never hands out repository credentials/i),
		).toBeInTheDocument();
	});

	it.each([
		["GITLAB", "glab auth login"],
		[
			"AZURE_DEVOPS",
			"git ls-remote https://github.com/example-org/instructions.git",
		],
	] as const)(
		"names the provider's own sign-in for %s",
		async (provider, command) => {
			await openGroup(provider);

			expect(
				screen.getByTestId("connect-cli-git-credentials-command"),
			).toHaveTextContent(command);
		},
	);

	it("copies the sign-in command", async () => {
		const { user } = await openGroup("GITHUB");

		await user.click(
			screen.getByRole("button", {
				name: "Copy the git sign-in command",
			}),
		);

		expect(clipboardWrite).toHaveBeenCalledWith("gh auth login");
	});

	it("is not offered for an upload project, which has no repository to sign in to", async () => {
		renderInstructions({ kind: "upload" });
		await setupLine();

		expect(
			screen.queryByTestId("connect-cli-git-credentials"),
		).not.toBeInTheDocument();
		expect(
			screen.getByTestId("connect-cli-key-alternative"),
		).toBeInTheDocument();
	});

	it("is not offered on the project purpose", async () => {
		renderHost({ startOpen: true, localSetup: REPOSITORY_ROUTE });
		await screen.findByRole("dialog");

		expect(
			screen.queryByTestId("connect-cli-git-credentials"),
		).not.toBeInTheDocument();
	});
});

describe("ConnectCliDialog — the footer", () => {
	it("says no keys are inside, with a lock, before a key is created", async () => {
		renderInstructions();
		await setupLine();

		const note = screen.getByTestId("connect-cli-no-keys-note");

		expect(note).toHaveTextContent(
			"No keys inside — safe to share or commit",
		);
		expect(note.querySelector("svg")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
