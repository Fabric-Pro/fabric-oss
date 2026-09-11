/**
 * Tests for `ConnectCliDialog` — the one place an API key is minted and a
 * finished MCP client configuration is shown (Fizzy #2457, U7).
 *
 * What is pinned here, and why each one is load-bearing:
 *
 *   1. Opening mints nothing. A curious click must leave no credential behind
 *      (R30), so the create control is the only thing that reaches the API.
 *   2. The scopes are exactly `["mcp:read"]` and there is no picker (R8).
 *      `scopeSatisfied` short-circuits on `mcp:write` and returns true for
 *      EVERY tool, so the procedure's default pair is a full-access grant. A
 *      test that only asserted "some scopes were sent" would let that back in.
 *   3. The organization id is the one passed in, never the session's active
 *      organization — those legitimately differ, and minting against the wrong
 *      tenant is silent when it happens.
 *   4. The configuration names `/api/mcp-gateway` and never the alternate
 *      `/mcp` host (R20), which answers an organization key with a successful
 *      connection and an empty tool list — a failure with nothing to read.
 *   5. The secret survives the caller's eligibility flipping to false. That
 *      flip really happens: the readiness query refetches after any successful
 *      mutation, so minting turns the caller's own gate off. If the view were
 *      inside that gated subtree it would unmount holding the only copy of a
 *      secret the server stores as a hash.
 *   6. A failed issuance leaves the view open (same reason inverted: closing on
 *      error throws away the disclosure the reader just read and makes them
 *      start over).
 *   7. Focus lands on the copy control when the configuration appears and
 *      returns to the invoking control on close (R31 / AE22).
 *   8. While the configuration is on screen and has NOT been copied, Escape, a
 *      click outside, the close button and the link out to settings are all
 *      disarmed, and the blocked dismissal is announced rather than silently
 *      swallowed. Closing destroys the only plaintext copy of the key — the
 *      server keeps a hash — so a reflex Escape leaves a live 90-day
 *      credential behind and offers to mint a second one. "Done" stays a
 *      working exit: this is an accident guard, not a hostage situation.
 *   9. Nothing here runs the starter instruction for the reader. Such a
 *      shortcut can only carry the prompt TEXT to a chat destination, never
 *      the configuration block, so it lands in a tool with no Fabric MCP
 *      server registered and fails with nothing to read.
 *
 * `@tanstack/react-query` is real rather than mocked: the mint path runs
 * mutate -> onSuccess -> state -> focus effect, and a stubbed `useMutation`
 * would let a broken pending or error branch pass.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createKeyMock } = vi.hoisted(() => ({
	createKeyMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			apiKeys: {
				create: (input: unknown) => createKeyMock(input),
			},
		},
	},
}));

import { ConnectCliDialog } from "../ConnectCliDialog";

const ORGANIZATION_ID = "org-hosting-the-project";
const ORGANIZATION_SLUG = "example-org";
const PROJECT_NAME = "Checkout Rewrite";
const RAW_KEY = "org_1a2b3c4d_ZXhhbXBsZS1zZWNyZXQtdmFsdWU";

function issuedKeyFixture() {
	return {
		id: "key-1",
		name: "Coding CLI (created from the connect prompt)",
		keyPrefix: "org_1a2b3c4d",
		rawKey: RAW_KEY,
		scopes: ["mcp:read"],
		expiresAt: new Date("2026-12-09T00:00:00.000Z"),
		createdAt: new Date("2026-09-10T00:00:00.000Z"),
	};
}

function Wrapper({ children }: { children: ReactNode }) {
	// Created once per mount, not once per render: a fresh client on every
	// render would drop the mutation's own pending/error state mid-flow.
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			}),
	);
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/**
 * Mirrors how the two mounting surfaces are required to use this view: the
 * control that opens it sits inside the eligibility-gated subtree, the dialog
 * itself sits OUTSIDE it. `eligible` is a prop rather than harness state so a
 * test can flip it with `rerender`, standing in for the readiness refetch that
 * flips it in production — clicking a harness control would not work, because
 * a modal dialog puts the rest of the document behind `pointer-events: none`.
 */
function Host({
	startOpen = false,
	eligible = true,
}: {
	startOpen?: boolean;
	eligible?: boolean;
}) {
	const [open, setOpen] = useState(startOpen);

	return (
		<>
			{eligible && (
				<button type="button" onClick={() => setOpen(true)}>
					Connect a coding tool
				</button>
			)}
			<ConnectCliDialog
				open={open}
				onOpenChange={setOpen}
				organizationId={ORGANIZATION_ID}
				organizationSlug={ORGANIZATION_SLUG}
				projectName={PROJECT_NAME}
			/>
		</>
	);
}

function renderHost(props?: { startOpen?: boolean }) {
	return render(<Host {...props} />, { wrapper: Wrapper });
}

/**
 * `userEvent.setup()` installs its own clipboard stub over
 * `navigator.clipboard`, so the spy has to go on afterwards or every write
 * lands in userEvent's stub and the assertion sees no calls.
 */
function setupUser() {
	const user = userEvent.setup();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: clipboardWrite },
	});
	return user;
}

function configurationText() {
	return screen.getByTestId("connect-cli-configuration").textContent ?? "";
}

const clipboardWrite = vi.fn(async () => {});

beforeEach(() => {
	createKeyMock.mockReset();
	createKeyMock.mockResolvedValue(issuedKeyFixture());
	clipboardWrite.mockReset();
	clipboardWrite.mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: clipboardWrite },
	});
});

describe("ConnectCliDialog — minting", () => {
	it("mints nothing when the dialog is merely opened", async () => {
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		expect(
			await screen.findByRole("button", { name: /create the key/i }),
		).toBeInTheDocument();
		expect(createKeyMock).not.toHaveBeenCalled();
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
	});

	it("mints a key on the create control and renders the configuration with the gateway endpoint and the returned secret", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);
		expect(createKeyMock).toHaveBeenCalledTimes(1);

		const rendered = configurationText();
		expect(rendered).toContain("/api/mcp-gateway");
		expect(rendered).toContain(RAW_KEY);
		expect(rendered).toContain(`Bearer ${RAW_KEY}`);
		expect(rendered).toContain('"type": "http"');
	});

	it("sends exactly the read-only scope, the identifying name and the bounded expiry, and offers no scope picker", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
		expect(
			within(dialog).queryByText(/mcp:write/i),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByText(/permissions/i),
		).not.toBeInTheDocument();

		await user.click(
			within(dialog).getByRole("button", { name: /create the key/i }),
		);

		await waitFor(() => expect(createKeyMock).toHaveBeenCalledTimes(1));
		const input = createKeyMock.mock.calls[0][0] as {
			scopes: string[];
			name: string;
			expiresInDays: number;
		};
		expect(input.scopes).toEqual(["mcp:read"]);
		expect(input.name).toBe("Coding CLI (created from the connect prompt)");
		expect(input.expiresInDays).toBe(90);
	});

	it("mints against the project's host organization", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		await waitFor(() => expect(createKeyMock).toHaveBeenCalledTimes(1));
		expect(createKeyMock.mock.calls[0][0]).toMatchObject({
			organizationId: ORGANIZATION_ID,
		});
	});
});

describe("ConnectCliDialog — disclosure", () => {
	it("renders the pre-mint disclosure above the create control", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		const disclosure = within(dialog).getByText(
			/before you create the key/i,
		);
		const createButton = within(dialog).getByRole("button", {
			name: /create the key/i,
		});

		expect(
			disclosure.compareDocumentPosition(createButton) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("says what the key grants before anything is minted", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		// Authenticates as the viewer, across the whole organization.
		expect(
			within(dialog).getByText(/authenticates as you/i),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText(/every project in it/i),
		).toBeInTheDocument();
		// Persists until revoked, and the configuration carries a live credential.
		expect(
			within(dialog).getByText(/until you revoke it/i),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText(/live credential/i),
		).toBeInTheDocument();
	});
});

describe("ConnectCliDialog — the configuration", () => {
	async function mint() {
		const user = setupUser();
		renderHost({ startOpen: true });
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);
		return user;
	}

	it("warns that the key is shown once and names where it can be revoked", async () => {
		const user = await mint();

		expect(screen.getByText(/shown once/i)).toBeInTheDocument();
		expect(
			screen.getByText(/cannot be retrieved afterwards/i),
		).toBeInTheDocument();
		// The revocation page is named in prose from the moment the key
		// exists — that half of the promise never depends on copying.
		expect(screen.getByText(/api keys settings page/i)).toBeInTheDocument();

		// CHANGED (Fizzy #2457, finding #6): the LINK is withheld until the
		// configuration has been copied, because following it is a client-side
		// navigation that unmounts the only holder of the plaintext key. The
		// assertion is not weakened — the same href is still required, one
		// step later — and the withheld state is pinned by its own test below.
		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);

		expect(
			await screen.findByRole("link", { name: /api keys settings/i }),
		).toHaveAttribute(
			"href",
			`/app/${ORGANIZATION_SLUG}/settings/api-keys`,
		);
	});

	it("withholds the settings link until the configuration has been copied", async () => {
		const user = await mint();

		expect(
			screen.queryByRole("link", { name: /api keys settings/i }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);

		expect(
			await screen.findByRole("link", { name: /api keys settings/i }),
		).toBeInTheDocument();
	});

	it("copies the configuration and the copy control reaches its confirmed state", async () => {
		const user = await mint();

		const copyButton = screen.getByRole("button", {
			name: /copy configuration/i,
		});
		await user.click(copyButton);

		expect(clipboardWrite).toHaveBeenCalledWith(configurationText());
		expect(
			await screen.findByRole("button", { name: /^copied$/i }),
		).toBeInTheDocument();
	});

	it("announces a successful copy to assistive technology", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);

		const liveRegion = document.querySelector('[aria-live="polite"]');
		expect(liveRegion).toBeTruthy();
		expect(liveRegion?.textContent).toBe("");

		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);

		await waitFor(() =>
			expect(
				document.querySelector('[aria-live="polite"]')?.textContent,
			).toMatch(/copied to the clipboard/i),
		);
	});

	it("never names the alternate /mcp host", async () => {
		await mint();

		const rendered = configurationText();
		const origin = window.location.origin;
		expect(rendered).not.toContain(`${origin}/mcp"`);
		expect(rendered).not.toMatch(/"url":\s*"[^"]*\/mcp"/);
		expect(rendered).toContain(`${origin}/api/mcp-gateway`);
	});

	it("puts initial focus on the copy control once the configuration renders", async () => {
		await mint();

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /copy configuration/i }),
			).toHaveFocus(),
		);
	});
});

describe("ConnectCliDialog — the starter instruction", () => {
	it("names the project in one copyable sentence", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		const instruction = await screen.findByTestId(
			"connect-cli-starter-instruction",
		);
		expect(instruction).toHaveTextContent(PROJECT_NAME);
		// One sentence: a single terminating period, and no line breaks.
		const text = instruction.textContent ?? "";
		expect(text.match(/\./g) ?? []).toHaveLength(1);
		expect(text).not.toContain("\n");

		await user.click(
			screen.getByRole("button", { name: /copy instruction/i }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(text);
	});

	/**
	 * REPLACES an assertion that this section offered a "Run" control
	 * (Fizzy #2457, finding #11).
	 *
	 * That control opened a chat destination with the prompt TEXT encoded into
	 * a query parameter and nothing else — it had no code path that could carry
	 * the configuration block this dialog had just generated. So every
	 * destination it opened started a conversation with a tool that had no
	 * Fabric MCP server registered, and failed with nothing to tell the reader
	 * that the configuration had to be pasted first. Copying is the whole flow;
	 * the MCP handshake teaches a correctly-configured client the rest.
	 */
	it("offers copying and no shortcut that would run the instruction somewhere unconfigured", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			await within(dialog).findByRole("button", {
				name: /copy instruction/i,
			}),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", { name: /^run$/i }),
		).not.toBeInTheDocument();
		// Nor any link out to a chat destination.
		for (const link of within(dialog).queryAllByRole("link")) {
			expect(link).toHaveAttribute("href", expect.stringMatching(/^\//));
		}
	});

	it("says the sentence has to be sent in the tool that was just configured", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		// The section has to read as a complete instruction on its own now
		// that nothing in it presses a button for the reader.
		expect(
			await screen.findByText(/send it in the tool you just configured/i),
		).toBeInTheDocument();
	});
});

/**
 * The dialog holds the ONLY plaintext copy of the key: the server stores a
 * hash, so a close is destruction, not a cancel. Every incidental dismissal is
 * therefore disarmed while the configuration is on screen uncopied, leaving a
 * deliberate "Done" as the one exit (Fizzy #2457, finding #6).
 *
 * The guards are gated on the configuration having been COPIED rather than on
 * a key merely existing — once a copy is safely out of the browser there is
 * nothing left to lose, and a modal that still refuses Escape at that point is
 * a trap with no remaining purpose.
 */
describe("ConnectCliDialog — holding the only copy of the key", () => {
	async function mintUncopied() {
		const user = setupUser();
		renderHost({ startOpen: true });
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);
		return user;
	}

	it("does not close on Escape, and does not clear the key, while the configuration is uncopied", async () => {
		const user = await mintUncopied();

		await user.keyboard("{Escape}");

		// Still open, and still holding the same secret — not re-minted.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(configurationText()).toContain(RAW_KEY);
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});

	it("announces the blocked dismissal rather than swallowing the key press", async () => {
		const user = await mintUncopied();

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(
				document.querySelector('[aria-live="polite"]')?.textContent,
			).toMatch(/has not been copied yet/i),
		);
		// And the same thing is on screen for a reader who is not using
		// assistive technology, described by the control that lifts it.
		const note = screen.getByTestId("connect-cli-dismissal-note");
		expect(note).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /copy configuration/i }),
		).toHaveAttribute("aria-describedby", note.id);
	});

	it("withholds the close button while the configuration is uncopied and restores it afterwards", async () => {
		const user = await mintUncopied();

		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).queryByRole("button", { name: /^close$/i }),
		).not.toBeInTheDocument();

		await user.click(
			within(dialog).getByRole("button", { name: /copy configuration/i }),
		);

		expect(
			await within(dialog).findByRole("button", { name: /^close$/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-dismissal-note"),
		).not.toBeInTheDocument();
	});

	it("closes on Escape once the configuration has been copied", async () => {
		const user = await mintUncopied();

		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);
		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("still closes on Escape before any key has been minted", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await screen.findByRole("dialog");

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(createKeyMock).not.toHaveBeenCalled();
	});

	it("closes on Done and clears the key, leaving nothing to reopen onto", async () => {
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);

		// Done is the deliberate exit, and it works even uncopied: the guards
		// prevent an accident, they do not hold the reader hostage.
		await user.click(screen.getByRole("button", { name: /^done$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// Reopening comes back to the pre-mint state: the secret is gone from
		// the client, and nothing was refetched to bring it back.
		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		expect(
			await screen.findByRole("button", { name: /create the key/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});
});

describe("ConnectCliDialog — resilience", () => {
	it("stays open and keeps the secret when the caller's eligibility flips to false", async () => {
		const user = setupUser();
		const { rerender } = render(<Host startOpen eligible />, {
			wrapper: Wrapper,
		});

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);

		// What the readiness refetch does to the caller after a successful
		// mutation: the opening control disappears out from under the dialog.
		rerender(<Host startOpen eligible={false} />);

		expect(
			screen.queryByText("Connect a coding tool"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(configurationText()).toContain(RAW_KEY);
		// The secret is never refetched — there is nothing to refetch it from.
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});

	it("shows the safe fallback and stays open when issuance fails", async () => {
		createKeyMock.mockRejectedValueOnce(
			new Error("You are not a member of this organization"),
		);
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		expect(
			await screen.findByText(/the key could not be created/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/something went wrong creating the key/i),
		).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
		// Still offered a retry rather than a dead end.
		expect(
			screen.getByRole("button", { name: /create the key/i }),
		).toBeInTheDocument();
	});

	/**
	 * The raw message never reaches the DOM (Fizzy #2457): whatever the
	 * mutation's error carries — a Prisma message, a driver detail, an
	 * internal constraint name — this repo is public and none of it belongs in
	 * the UI. `CliConnectionNudge` states the same rule for its own error
	 * handler. The real error is still surfaced, but to `console.error`, not
	 * the page.
	 */
	it("never renders the raw server error message, and logs it instead", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const internalMessage =
			'duplicate key value violates unique constraint "api_key_org_name_key"';
		createKeyMock.mockRejectedValueOnce(new Error(internalMessage));
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);

		expect(
			await screen.findByText(/the key could not be created/i),
		).toBeInTheDocument();
		expect(screen.queryByText(internalMessage)).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain(internalMessage);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to create the CLI connection key"),
			expect.objectContaining({ message: internalMessage }),
		);

		consoleErrorSpy.mockRestore();
	});
});

describe("ConnectCliDialog — focus", () => {
	it("returns focus to the invoking control on close", async () => {
		const user = setupUser();
		renderHost();

		const opener = screen.getByRole("button", {
			name: "Connect a coding tool",
		});
		await user.click(opener);
		await screen.findByRole("dialog");

		await user.click(screen.getByRole("button", { name: /^cancel$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("returns focus to the invoking control after a key has been issued", async () => {
		const user = setupUser();
		renderHost();

		const opener = screen.getByRole("button", {
			name: "Connect a coding tool",
		});
		await user.click(opener);
		await user.click(
			await screen.findByRole("button", { name: /create the key/i }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("connect-cli-configuration"),
			).toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: /^done$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("gives every icon-only control an accessible name", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		for (const button of within(dialog).getAllByRole("button")) {
			expect(button).toHaveAccessibleName();
		}
	});
});
