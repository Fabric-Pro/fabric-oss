/**
 * Tests for the tile picker and the terminal steps `ConnectCliDialog` shows for
 * Claude Code and Codex. The editors, the "Other" entry and the advanced rows
 * are pinned in `ConnectCliDialog.other-tools.test.tsx`; minting and the
 * dismissal guard in `ConnectCliDialog.test.tsx`.
 *
 * What is pinned here, and why:
 *
 *   1. The picker is a real tablist: arrow keys move between the tools, the
 *      selected one is announced, and the panel is named after it.
 *   2. For coding instructions, Claude Code and Codex show ONE line that carries
 *      no key, taken from the deployment's own discovery document and written
 *      against the page's own address, with `--tool` always named, and — for a
 *      clone — in ONE command, because Windows PowerShell 5.1 rejects `&&`.
 *   3. Where to run the line is never "any folder": an existing clone has to be
 *      entered at its top folder, or the sync's root folder inside it.
 *   4. What the hook does afterwards is said as it is true, per kind of project.
 *   5. A deployment that serves no CLI says so instead of printing a command
 *      that cannot work, and falls back to MCP.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clipboardWrite,
	deferred,
	discoveryResponse,
	fetchMock,
	INIT,
	INIT_WITH_BASE_URL,
	installBrowserStubs,
	liveRegionText,
	mintKey,
	OTHER_ORIGIN_DOCUMENT,
	PROJECT_GATEWAY,
	PROJECT_ID,
	REPOSITORY_ROUTE,
	renderHost,
	renderInstructions,
	setupLine,
	setupUser,
	UNBAKED_DOCUMENT,
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

const CLAUDE_CODE_LINE = `${INIT} --project ${PROJECT_ID} --tool claude-code`;

describe("ConnectCliDialog — the tool picker", () => {
	it("offers Claude Code, Codex, VS Code, Cursor and Other, in that order, as one tablist", async () => {
		renderInstructions();

		const list = await screen.findByRole("tablist", {
			name: "Choose your coding tool",
		});
		const tabs = within(list).getAllByRole("tab");

		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Claude Code",
			"Codex",
			"VS Code",
			"Cursor",
			"Other",
		]);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		// The retired controls: a tool radio, an apply checkbox, a five-line
		// block with "Copy commands", and an install-and-sign-in sequence.
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Copy commands" }),
		).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain("npm install -g");
		expect(document.body.textContent).not.toContain("fabric auth login");
		expect(document.body.textContent).not.toContain("FABRIC_BASE_URL");
	});

	it("moves between the tools with the arrow keys, and the panel follows the selected one", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();
		const claudeCode = screen.getByRole("tab", { name: "Claude Code" });
		await waitFor(() => expect(claudeCode).toHaveFocus());

		await user.keyboard("{ArrowRight}");

		const codex = screen.getByRole("tab", { name: "Codex" });
		expect(codex).toHaveAttribute("aria-selected", "true");
		expect(codex).toHaveFocus();
		expect(claudeCode).toHaveAttribute("aria-selected", "false");
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Codex");
		expect((await setupLine()).textContent).toContain("--tool codex");

		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: "VS Code" })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		await user.keyboard("{End}");
		expect(screen.getByRole("tab", { name: "Other" })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		await user.keyboard("{ArrowRight}");
		expect(
			screen.getByRole("tab", { name: "Claude Code" }),
		).toHaveAttribute("aria-selected", "true");

		await user.keyboard("{ArrowLeft}");
		expect(screen.getByRole("tab", { name: "Other" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("draws each tool's own mark from a local file, and the plug for Other", async () => {
		renderInstructions();
		await setupLine();

		const sources = [
			...screen.getByRole("tablist").querySelectorAll("img"),
		].map((image) => image.getAttribute("src"));

		expect(sources).toEqual([
			"/integrations/Anthropic.svg",
			"/integrations/Openai.svg",
			"/integrations/VisualStudioCode.svg",
			"/integrations/Cursor.svg",
		]);
		const other = screen.getByRole("tab", { name: "Other" });
		expect(other.querySelector("img")).toBeNull();
		expect(other.querySelector("svg")).not.toBeNull();
		// Decorative: the name is written beside every mark.
		for (const image of screen
			.getByRole("tablist")
			.querySelectorAll("img")) {
			expect(image).toHaveAttribute("alt", "");
		}
	});

	it("wraps a label rather than letting five tiles overflow a phone", async () => {
		renderInstructions();
		await setupLine();

		const list = screen.getByRole("tablist");
		expect(list.className).toContain("grid-cols-5");
		for (const tab of screen.getAllByRole("tab")) {
			expect(tab.className).toContain("whitespace-normal");
			expect(tab.className).not.toContain("whitespace-nowrap");
		}
	});

	it("marks the selected tile, which the unselected ones are not", async () => {
		renderInstructions();
		await setupLine();

		const [selected, other] = screen.getAllByRole("tab");

		expect(selected).toHaveAttribute("data-state", "active");
		expect(other).toHaveAttribute("data-state", "inactive");
		expect(selected.className).toContain("data-[state=active]:ring-1");
	});
});

describe("ConnectCliDialog — the terminal steps for a repository project", () => {
	it("lists three numbered steps: the repository, the terminal, the browser", async () => {
		renderInstructions();
		await setupLine();

		const steps = within(screen.getByRole("list")).getAllByRole("listitem");

		expect(steps).toHaveLength(3);
		expect(
			within(steps[0]).getByText("Where's the repository?"),
		).toBeVisible();
		expect(
			within(steps[1]).getByText("Run this in your terminal"),
		).toBeVisible();
		expect(
			within(steps[2]).getByText("Approve in your browser"),
		).toBeVisible();
	});

	it("fills the circles of the steps the person performs, and outlines the one in the browser", async () => {
		renderInstructions();
		await setupLine();

		const markers = within(screen.getByRole("list"))
			.getAllByRole("listitem")
			.map((step) => step.querySelector('span[aria-hidden="true"]'));

		expect(markers.map((marker) => marker?.textContent)).toEqual([
			"1",
			"2",
			"3",
		]);
		expect(markers[0]?.className).toContain("bg-primary");
		expect(markers[1]?.className).toContain("bg-primary");
		expect(markers[2]?.className).toContain("border-input");
		expect(markers[2]?.className).not.toContain("bg-primary");
	});

	it("gives Claude Code exactly one line, with the project and the tool named and no organization, URL or key", async () => {
		renderInstructions();

		const line = await setupLine();

		expect(line.textContent).toBe(CLAUDE_CODE_LINE);
		expect(line.textContent).not.toMatch(
			/--org|--base-url|--key|--clone|&&|auth login/,
		);
		expect(
			screen.getAllByRole("button", { name: "Copy the setup line" }),
		).toHaveLength(1);
	});

	it("prefixes the line with a prompt the person cannot select and the copy cannot carry", async () => {
		const user = setupUser();
		renderInstructions();
		const line = await setupLine();

		expect(line.textContent).not.toContain("$");
		const row = line.querySelector("code");
		expect(row?.className).toContain("before:content-['$']");
		expect(row?.className).toContain("before:select-none");

		await user.click(
			screen.getByRole("button", { name: "Copy the setup line" }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(CLAUDE_CODE_LINE);
	});

	it("takes the host from the page, not from the host the document says answered", async () => {
		renderInstructions();

		const line = await setupLine();

		expect(line.textContent).toContain(window.location.origin);
		expect(line.textContent).not.toContain("configured-host.example.com");
	});

	it("asks the deployment what it serves, once the dialog is open", async () => {
		renderInstructions();

		await setupLine();

		expect(fetchMock).toHaveBeenCalledWith(
			"/.well-known/fabric-cli.json",
			expect.anything(),
		);
	});

	it("wraps the command at spaces, breaking a word only when it cannot fit", async () => {
		renderInstructions();

		const line = await setupLine();

		expect(line.className).toContain("break-words");
		expect(line.className).not.toContain("break-all");
	});

	it("copies the line on the copy control, announces it, and reads 'Copied'", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.click(
			screen.getByRole("button", { name: "Copy the setup line" }),
		);

		expect(clipboardWrite).toHaveBeenCalledWith(CLAUDE_CODE_LINE);
		await waitFor(() =>
			expect(liveRegionText()).toMatch(
				/copy the setup line: copied to the clipboard/i,
			),
		);
		const step = screen.getAllByRole("listitem")[1];
		expect(
			await within(step).findByRole("button", { name: "Copied" }),
		).toBeInTheDocument();
	});

	it("says what Node the line needs, once, under the code", async () => {
		renderInstructions();
		const line = await setupLine();

		const note = screen.getByText("Needs Node.js 22 or later.");

		expect(screen.getAllByText("Needs Node.js 22 or later.")).toHaveLength(
			1,
		);
		expect(
			line.compareDocumentPosition(note) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("appends --tool codex on the Codex tile and says to trust the folder and the project hook", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.click(screen.getByRole("tab", { name: "Codex" }));

		expect((await setupLine()).textContent).toBe(
			`${INIT} --project ${PROJECT_ID} --tool codex`,
		);
		expect(
			screen.getByText(/trust this folder when asked/i),
		).toHaveTextContent(
			"Then, in Codex, trust this folder when asked and run /hooks once to trust the project hook.",
		);
	});

	it("does not mention hook trust on the Claude Code tile", async () => {
		renderInstructions();
		await setupLine();

		expect(screen.queryByText(/\/hooks/)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/trust this folder/i),
		).not.toBeInTheDocument();
	});

	it("says the hook fast-forwards the route's branch when the checkout is clean, and says so when it cannot", async () => {
		renderInstructions({ ...REPOSITORY_ROUTE, ref: "release/2" });

		await setupLine();

		const step = screen.getAllByRole("listitem")[2];
		expect(step).toHaveTextContent(
			"A sign-in page opens. After that, at each session start a hook fast-forwards release/2 to the newest instructions when your checkout is clean, and says so when it cannot.",
		);
		expect(within(step).getByText("release/2").tagName).toBe("CODE");
	});
});

describe("ConnectCliDialog — where to run the line", () => {
	it("offers to use the checkout the person already has, or to clone it, as a radio group", async () => {
		renderInstructions();
		await setupLine();

		const group = screen.getByRole("radiogroup", {
			name: "Where's the repository?",
		});
		const have = within(group).getByRole("radio", {
			name: "Already cloned",
		});
		const clone = within(group).getByRole("radio", {
			name: "Clone it for me",
		});

		expect(have).toBeChecked();
		expect(clone).not.toBeChecked();
	});

	it("moves the choice with the arrow keys", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();
		screen.getByRole("radio", { name: "Already cloned" }).focus();

		// Radix moves focus on a timer and selects the radio it lands on only
		// while an arrow key is still down, as it is for a person; a key
		// released in the same tick would be gone before the focus arrives.
		await user.keyboard("{ArrowRight>}");
		await waitFor(() =>
			expect(
				screen.getByRole("radio", { name: "Clone it for me" }),
			).toBeChecked(),
		);
		await user.keyboard("{/ArrowRight}");
		expect((await setupLine()).textContent).toContain(
			"--clone instructions",
		);
	});

	it("names the repository, and says to run it in the sync's root folder inside the clone", async () => {
		renderInstructions();
		await setupLine();

		const step = screen.getAllByRole("listitem")[0];

		expect(step).toHaveTextContent("example-org/instructions");
		expect(step).toHaveTextContent("run it in agents/ inside your clone");
		expect(step.textContent).not.toMatch(/any folder/i);
	});

	it("says to run it in the top folder of the clone when the instructions are not in a subfolder", async () => {
		renderInstructions({ ...REPOSITORY_ROUTE, rootPath: null });
		await setupLine();

		const step = screen.getAllByRole("listitem")[0];

		expect(step).toHaveTextContent(
			"run it in the top folder of your clone",
		);
		expect(step.textContent).not.toMatch(/any folder|agents/i);
	});

	it("clones in ONE command, naming the project, the tool and the folder", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.click(
			screen.getByRole("radio", { name: "Clone it for me" }),
		);

		const cloneLine = (await setupLine()).textContent;
		expect(cloneLine).toBe(
			`${INIT} --project ${PROJECT_ID} --tool claude-code --clone instructions`,
		);
		// Windows PowerShell 5.1 rejects `&&`, and there is nothing left to chain.
		expect(cloneLine).not.toMatch(/&&|git clone|\bcd\b/);
		expect(screen.getAllByTestId("agent-sign-in-setup-line")).toHaveLength(
			1,
		);
		await user.click(
			screen.getByRole("button", { name: "Copy the setup line" }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(cloneLine);
	});

	it("says a clone lands in a new folder, by name", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.click(
			screen.getByRole("radio", { name: "Clone it for me" }),
		);

		const step = screen.getAllByRole("listitem")[0];
		expect(step).toHaveTextContent(
			"cloned into a new folder, instructions",
		);
		expect(step.textContent).not.toMatch(/any folder/i);
	});

	it("keeps the clone choice when the tool changes, and names the tool in the clone line", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();
		await user.click(
			screen.getByRole("radio", { name: "Clone it for me" }),
		);

		await user.click(screen.getByRole("tab", { name: "Codex" }));

		expect(
			screen.getByRole("radio", { name: "Clone it for me" }),
		).toBeChecked();
		expect((await setupLine()).textContent).toBe(
			`${INIT} --project ${PROJECT_ID} --tool codex --clone instructions`,
		);
	});

	it("quotes a project id, a directory and a base URL, so the pasted line cannot be split into extra commands", async () => {
		fetchMock.mockImplementation(async () =>
			discoveryResponse(200, UNBAKED_DOCUMENT),
		);
		const user = setupUser();
		renderInstructions({
			...REPOSITORY_ROUTE,
			directory: "rules&x",
			rootPath: null,
		});
		await setupLine();

		await user.click(
			screen.getByRole("radio", { name: "Clone it for me" }),
		);

		expect((await setupLine()).textContent).toBe(
			`${INIT_WITH_BASE_URL} --project ${PROJECT_ID} --tool claude-code --clone 'rules&x'`,
		);
	});

	it("will not hand a folder that starts with a dash to --clone as if it were a flag", async () => {
		const user = setupUser();
		renderInstructions({ ...REPOSITORY_ROUTE, directory: "-rules" });
		await setupLine();

		await user.click(
			screen.getByRole("radio", { name: "Clone it for me" }),
		);

		expect((await setupLine()).textContent).toBe(
			`${INIT} --project ${PROJECT_ID} --tool claude-code --clone ./-rules`,
		);
	});
});

describe("ConnectCliDialog — the terminal steps for an upload project", () => {
	it("starts at the terminal, with no repository step and no radios", async () => {
		renderInstructions({ kind: "upload" });

		const line = await setupLine();

		const steps = within(screen.getByRole("list")).getAllByRole("listitem");
		expect(steps).toHaveLength(2);
		expect(
			within(steps[0]).getByText("Run this in your terminal"),
		).toBeVisible();
		expect(
			within(steps[1]).getByText("Approve in your browser"),
		).toBeVisible();
		expect(screen.queryByRole("radio")).not.toBeInTheDocument();
		expect(screen.queryByText("Where's the repository?")).toBeNull();
		expect(line.textContent).toBe(
			`${INIT} --project ${PROJECT_ID} --tool claude-code`,
		);
	});

	it("says where to run it, and offers no git help", async () => {
		renderInstructions({ kind: "upload" });
		await setupLine();

		expect(
			screen.getByText("Run it in the folder your agent works in."),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-git-credentials"),
		).not.toBeInTheDocument();
	});

	it("says the hook tells you when the instructions change, and does not claim to move a branch", async () => {
		renderInstructions({ kind: "upload" });
		await setupLine();

		const step = screen.getAllByRole("listitem")[1];

		expect(step).toHaveTextContent(
			"A sign-in page opens. After that, at each session start a hook tells you when the published instructions have changed.",
		);
		expect(step.textContent).not.toMatch(/fast-forward/i);
	});

	it("keeps the base URL, the project and the tool in one line for Codex", async () => {
		fetchMock.mockImplementation(async () =>
			discoveryResponse(200, UNBAKED_DOCUMENT),
		);
		const user = setupUser();
		renderInstructions({ kind: "upload" });
		await setupLine();

		await user.click(screen.getByRole("tab", { name: "Codex" }));

		expect((await setupLine()).textContent).toBe(
			`${INIT_WITH_BASE_URL} --project ${PROJECT_ID} --tool codex`,
		);
	});
});

describe("ConnectCliDialog — what the deployment serves", () => {
	it("shows a note while the deployment is being asked, and no command", async () => {
		const pending = deferred<Response>();
		fetchMock.mockReturnValue(pending.promise);
		renderInstructions();

		expect(
			await screen.findByText(/checking what this deployment serves/i),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("agent-sign-in-setup-line"),
		).not.toBeInTheDocument();

		pending.resolve(discoveryResponse());
		expect((await setupLine()).textContent).toBe(CLAUDE_CODE_LINE);
	});

	it("says so, and falls back to MCP in numbered steps, when the deployment serves no CLI", async () => {
		fetchMock.mockImplementation(async () =>
			discoveryResponse(404, { error: "cli_not_served" }),
		);
		renderInstructions();

		expect(
			await screen.findByTestId("agent-sign-in-line-unavailable"),
		).toHaveTextContent(/does not serve the Fabric CLI/i);
		expect(
			screen.queryByTestId("agent-sign-in-setup-line"),
		).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain("npx -y");
		expect(
			screen.getByTestId("agent-sign-in-claude-code"),
		).toHaveTextContent(
			`claude mcp add --scope local --transport http fabric-ewrite ${PROJECT_GATEWAY}`,
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	// The build often cannot know the address it will be served at (Vercel
	// passes none), so the line says it: `--base-url` always wins over a bake,
	// which makes a tarball baked for another address harmless.
	it.each([
		["built for no address", UNBAKED_DOCUMENT],
		["built for another address", OTHER_ORIGIN_DOCUMENT],
	])(
		"writes --base-url with the page's origin for a tarball %s",
		async (_label, document) => {
			fetchMock.mockImplementation(async () =>
				discoveryResponse(200, document),
			);
			renderInstructions();

			const line = await setupLine();

			expect(line.textContent).toBe(
				`${INIT_WITH_BASE_URL} --project ${PROJECT_ID} --tool claude-code`,
			);
			expect(
				screen.queryByTestId("agent-sign-in-line-unavailable"),
			).not.toBeInTheDocument();
			expect(window.document.body.textContent).not.toContain(
				"built-for.example.com",
			);
		},
	);

	it("treats a reply that is not the discovery document as 'not served'", async () => {
		fetchMock.mockImplementation(async () =>
			discoveryResponse(200, {
				tarball: "https://elsewhere.example.com/x.tgz",
			}),
		);
		renderInstructions();

		expect(
			await screen.findByTestId("agent-sign-in-line-unavailable"),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("npx -y");
	});

	it("treats a failed request as 'not served' rather than printing a command it could not check", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		renderInstructions();

		expect(
			await screen.findByTestId("agent-sign-in-line-unavailable"),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("npx -y");
	});

	it("offers no line for a project whose source is not known yet, and connects over MCP", async () => {
		renderInstructions(null);

		expect(
			await screen.findByTestId("agent-sign-in-line-unavailable"),
		).toHaveTextContent(/not available for this project yet/i);
		expect(
			screen.queryByTestId("agent-sign-in-setup-line"),
		).not.toBeInTheDocument();
		expect(
			screen.getByTestId("agent-sign-in-claude-code"),
		).toBeInTheDocument();
	});

	it("does not ask the deployment anything until the dialog is opened", async () => {
		renderHost({
			purpose: "coding-instructions",
			localSetup: REPOSITORY_ROUTE,
		});

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("ConnectCliDialog — the project purpose", () => {
	it("connects Claude Code over MCP in numbered steps, and asks the deployment nothing", async () => {
		renderHost({ startOpen: true, localSetup: { kind: "upload" } });

		await screen.findByRole("dialog");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			screen.getByTestId("agent-sign-in-claude-code"),
		).toHaveTextContent(
			`claude mcp add --scope local --transport http fabric-ewrite ${PROJECT_GATEWAY}`,
		);
		expect(
			screen.queryByTestId("agent-sign-in-setup-line"),
		).not.toBeInTheDocument();
		const steps = screen.getAllByRole("listitem");
		expect(steps).toHaveLength(2);
		expect(steps[1]).toHaveTextContent(/run \/mcp in Claude Code/i);
		expect(screen.queryByText(/needs node\.js/i)).not.toBeInTheDocument();
	});

	it("adds Codex over MCP with one command, which opens the browser itself", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(await screen.findByRole("tab", { name: "Codex" }));

		const block = screen.getByTestId("agent-sign-in-codex");
		expect(
			[...block.querySelectorAll("code")].map((row) => row.textContent),
		).toEqual([`codex mcp add fabric-ewrite --url ${PROJECT_GATEWAY}`]);
		expect(block).not.toHaveTextContent("codex mcp login");
		expect(screen.queryByText(/second command/i)).not.toBeInTheDocument();
		expect(
			screen.getByText(/command opens your browser/i),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Copy the Codex command" }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(
			`codex mcp add fabric-ewrite --url ${PROJECT_GATEWAY}`,
		);
		expect(screen.queryByText(/\/hooks/)).not.toBeInTheDocument();
	});

	it("never puts the minted key into the sign-in steps, and announces their copies in the one live region", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);

		const signIn = screen.getByTestId("agent-sign-in");
		expect(signIn.textContent).not.toContain("org_1a2b3c4d");

		await user.click(
			within(signIn).getByRole("button", {
				name: "Copy the Claude Code command",
			}),
		);

		expect(clipboardWrite).toHaveBeenCalledWith(
			`claude mcp add --scope local --transport http fabric-ewrite ${PROJECT_GATEWAY}`,
		);
		expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(
			1,
		);
		await waitFor(() =>
			expect(liveRegionText()).toMatch(
				/claude code command: copied to the clipboard/i,
			),
		);
		// Copying a keyless command is not taking the key: the guard holds.
		expect(
			screen.getByTestId("connect-cli-dismissal-note"),
		).toBeInTheDocument();
	});
});
