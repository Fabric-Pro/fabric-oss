"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	AlertTriangleIcon,
	CheckIcon,
	CopyIcon,
	KeyIcon,
	PlugIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Every user-visible sentence lives here rather than inline in the JSX, so the */
/* wording that needs product sign-off is reviewable in one place. Same         */
/* treatment as `AnthropicCapabilityBanner`, whose approved sentences are       */
/* hoisted for the same reason.                                                 */
/* -------------------------------------------------------------------------- */

const DIALOG_TITLE = "Connect Fabric to your coding tool";

const DIALOG_DESCRIPTION =
	"Create a key, paste one configuration block into your coding tool, and it can read this project's context while you work.";

/** Section 1 — what the key grants, said before anything is minted (R27). */
const DISCLOSURE_LABEL = "Before you create the key";

const DISCLOSURE_POINTS = [
	"The key authenticates as you. A tool holding it reads everything you can read in this organization — every project in it, not only this one.",
	"It is read-only: a tool holding it can read your work in Fabric, and cannot change it.",
	"It stays valid until you revoke it, or until it expires 90 days from now, whichever comes first.",
	"The configuration shown next contains a live credential. Treat it like a password — do not paste it into a shared document, a ticket or a chat.",
] as const;

const CREATE_KEY_LABEL = "Create the key";

const CREATE_KEY_PENDING_LABEL = "Creating the key…";

const ISSUE_ERROR_TITLE = "The key could not be created";

const ISSUE_ERROR_FALLBACK =
	"Something went wrong creating the key. Try again, or create one from the organization's API keys settings.";

/** Section 2 — the finished configuration. */
const CONFIGURATION_LABEL = "Your configuration";

const CONFIGURATION_INTRO =
	"Paste this into your coding tool's MCP configuration.";

const SHOWN_ONCE_TITLE = "Shown once";

const SHOWN_ONCE_BODY =
	"This is the only time the key is shown. Copy the configuration now — it cannot be retrieved afterwards, and replacing it means creating another key.";

const REVOKE_LOCATION =
	"You can review this key, see when it was last used, or revoke it on the organization's API keys settings page.";

const REVOKE_LINK_LABEL = "API keys settings";

const COPY_CONFIGURATION_LABEL = "Copy configuration";

const COPY_INSTRUCTION_LABEL = "Copy instruction";

const COPIED_LABEL = "Copied";

const CONFIGURATION_COPIED_ANNOUNCEMENT =
	"Configuration copied to the clipboard.";

const INSTRUCTION_COPIED_ANNOUNCEMENT =
	"Starter instruction copied to the clipboard.";

const COPY_FAILED_ANNOUNCEMENT =
	"Copying failed. Select the text and copy it manually.";

/**
 * Said while the configuration is on screen and has NOT been copied.
 *
 * The dialog holds the only plaintext copy of the key — the server keeps a hash
 * — so every incidental dismissal is disarmed until it has been copied. That
 * has to be stated rather than merely felt: a reader who presses Escape and
 * sees nothing happen must be told why, not left wondering whether the key
 * press registered.
 */
const UNCOPIED_DISMISSAL_NOTE =
	"Until you copy it, Escape and clicking outside will not close this dialog, and the link to the settings page is held back — either would leave with the only copy of the key. “Done” closes and discards the key whenever you choose.";

/** Read out when a dismissal is disarmed, so the blocked key press is not silent. */
const DISMISSAL_BLOCKED_ANNOUNCEMENT =
	"The configuration has not been copied yet, so the dialog stayed open. Copy it, or choose Done to close and discard the key.";

/** Section 3 — the starter instruction. */
const INSTRUCTION_LABEL = "Then say this to your tool";

/**
 * Why the sentence below is a sentence to copy and not a button to press.
 *
 * There is deliberately nothing here that opens a chat for the reader. A
 * destination opened from Fabric carries the prompt text and nothing else — not
 * the configuration block above — so it would start a conversation with a tool
 * that has no Fabric MCP server registered, and fail with no hint that the
 * configuration had to be pasted first (Fizzy #2457).
 */
const INSTRUCTION_INTRO =
	"Copy this sentence and send it in the tool you just configured. It only works there: the configuration above is what gives the tool access to this project.";

/**
 * The one sentence a reader pastes into their coding tool.
 *
 * Deliberately one sentence and no more. The gateway already ships a handshake
 * `instructions` block to every client that connects, and the tool descriptions
 * chain the first calls themselves, so re-teaching any of that here would spend
 * the only sentence the reader will actually paste on something they are being
 * told twice.
 */
function buildStarterInstruction(projectName: string): string {
	return `Use the Fabric MCP server to load the context for the project "${projectName}" and help me work on it.`;
}

const DONE_LABEL = "Done";

const CANCEL_LABEL = "Cancel";

/* -------------------------------------------------------------------------- */
/* Minting parameters                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The scopes the minted key carries — read-only, and no picker.
 *
 * NOT the procedure's `["mcp:read", "mcp:write"]` default. `scopeSatisfied` in
 * `@saas/mcp/lib/gateway/platform-tools` short-circuits on `mcp:write` and
 * returns true for EVERY tool, writes included, so the default pair is a
 * full-access grant wearing a two-item list. Handing that out from a banner is
 * out of this feature's scope; `mcp:read` satisfies exactly the tools whose
 * `kind` is `"read"`, which is what the reader is promised above.
 */
const ISSUED_KEY_SCOPES = ["mcp:read"] as const;

/**
 * The name the key is stored under.
 *
 * Its job is to be recognisable months later in the organization's API keys
 * table by someone who was not the person who clicked: it says what the key is
 * for and where it came from, so an unfamiliar row is not a mystery to
 * investigate before it can safely be revoked.
 */
const ISSUED_KEY_NAME = "Coding CLI (created from the connect prompt)";

/**
 * How long the key lives, in days.
 *
 * Bounded rather than perpetual because this key is minted from a prompt, in
 * one click, by someone who may never think about it again — the population
 * least likely to retire a credential by hand. 90 days is the common
 * rotation period, long enough that it is not a weekly interruption and short
 * enough that an abandoned key stops being a live credential within a quarter.
 * The procedure caps `expiresInDays` at 365.
 */
const ISSUED_KEY_EXPIRY_DAYS = 90;

/**
 * The endpoint the configuration names.
 *
 * It must be the gateway and never the alternate `/mcp` host. That host
 * verifies personal keys only, so an organization key reaches it, fails to
 * resolve, and the client is handed a *successful* connection with an empty
 * tool list — a reader with no error to read and nothing to fix.
 */
const MCP_GATEWAY_PATH = "/api/mcp-gateway";

/** The organization settings page where the key can later be revoked. */
function apiKeysSettingsPath(organizationSlug: string): string {
	return `/app/${organizationSlug}/settings/api-keys`;
}

/**
 * Build the client configuration with the secret already inlined.
 *
 * An http-type MCP server entry carrying the key as a bearer header: the shape
 * Claude Code, Cursor and VS Code all accept, and the shape the gateway
 * actually authenticates.
 */
function buildMcpConfiguration(origin: string, rawKey: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				fabric: {
					type: "http",
					url: `${origin}${MCP_GATEWAY_PATH}`,
					headers: {
						Authorization: `Bearer ${rawKey}`,
					},
				},
			},
		},
		null,
		2,
	);
}

type CopyTarget = "configuration" | "instruction";

interface ConnectCliDialogProps {
	/** Controlled by the caller. This view never gates its own visibility. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The organization that HOSTS the project on screen.
	 *
	 * Passed explicitly and never read from the session's active organization,
	 * which is a best-effort pointer and can legitimately name a different
	 * tenant than the project being viewed — minting there would issue a key
	 * against an organization the reader did not ask about.
	 */
	organizationId: string;
	/**
	 * That same organization's slug, used only to link its API keys settings.
	 * Optional: without it the page is named in prose instead of linked, which
	 * still satisfies "say where the key can be revoked".
	 */
	organizationSlug?: string;
	/** Named in the starter instruction so the tool opens on the right project. */
	projectName: string;
	/**
	 * Fired once, after a key is successfully issued.
	 *
	 * The "key issued" funnel event belongs to whichever surface opened this
	 * view — the prompt and the checklist row record different origins — so the
	 * event is raised here and recorded there.
	 */
	onKeyIssued?: () => void;
}

/**
 * The one place an API key is minted and a finished MCP client configuration is
 * shown.
 *
 * A dialog, not an inline expansion, and it gates its own visibility on
 * nothing. That is structural, not cosmetic: the readiness query refetches
 * after any successful mutation, so minting a key flips the caller's own
 * eligibility to false. Rendered inside that gated subtree, this view would
 * unmount at the exact moment it holds the only copy of a secret that cannot be
 * fetched again. Callers must mount it OUTSIDE whatever they gate.
 *
 * The secret lives in component state and is never refetched, because there is
 * nothing to refetch it from: the server stores a hash. For that same reason,
 * while the configuration is on screen and has not been copied, every
 * incidental dismissal — Escape, a click outside, the close button, the link
 * out to settings — is disarmed, leaving "Done" as the one deliberate exit
 * (Fizzy #2457).
 */
export function ConnectCliDialog({
	open,
	onOpenChange,
	organizationId,
	organizationSlug,
	projectName,
	onKeyIssued,
}: ConnectCliDialogProps) {
	const [rawKey, setRawKey] = useState<string | null>(null);
	const [copied, setCopied] = useState<CopyTarget | null>(null);
	/**
	 * Whether the CONFIGURATION specifically has reached the clipboard.
	 *
	 * Separate from `copied`, which names the most recent copy and is therefore
	 * overwritten the moment the starter instruction is copied — reading the
	 * guards off that would re-arm every dismissal behind the reader's back.
	 * This one latches on the first successful configuration copy and is only
	 * cleared when the view closes.
	 */
	const [configurationCopied, setConfigurationCopied] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const [origin, setOrigin] = useState("");
	const copyConfigurationRef = useRef<HTMLButtonElement>(null);
	/**
	 * The control that opened this view, so focus can be handed back to it.
	 *
	 * Recorded rather than inferred, because Radix returns focus to its own
	 * `DialogTrigger` and this dialog deliberately has none: it is mounted
	 * outside the subtree its callers gate, and opened by a control that lives
	 * inside it. Without this the reader is dropped on `document.body` and has
	 * to tab back through the page to where they were.
	 */
	const invokerRef = useRef<HTMLElement | null>(null);

	// Read on the client only, so the rendered URL cannot differ between the
	// server pass and hydration. Same approach as the API keys settings page.
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

	const createKeyMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.organizations.apiKeys.create({
				organizationId,
				name: ISSUED_KEY_NAME,
				scopes: [...ISSUED_KEY_SCOPES],
				expiresInDays: ISSUED_KEY_EXPIRY_DAYS,
			}),
		onSuccess: (data) => {
			setRawKey(data.rawKey);
			onKeyIssued?.();
		},
		onError: (error) => {
			// Never render a raw server message: this repo is public and such a
			// string can carry an internal detail (a driver error, a constraint
			// name) that has no business in UI. Same rule `CliConnectionNudge`
			// states for its own error handler — logged here instead so the
			// real error is not lost.
			console.error("Failed to create the CLI connection key", error);
		},
	});

	// Initial focus lands on the copy control the moment the configuration
	// appears: it is the only thing in this view that must happen before the
	// dialog closes, and the secret is unrecoverable if it does not.
	useEffect(() => {
		if (rawKey) {
			copyConfigurationRef.current?.focus();
		}
	}, [rawKey]);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			// The secret is gone from the client as soon as this view closes,
			// which is the honest reflection of the warning it just showed.
			setRawKey(null);
			setCopied(null);
			setConfigurationCopied(false);
			setAnnouncement("");
			createKeyMutation.reset();
		}
		onOpenChange(nextOpen);
	};

	const copy = async (target: CopyTarget, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(target);
			if (target === "configuration") {
				setConfigurationCopied(true);
			}
			setAnnouncement(
				target === "configuration"
					? CONFIGURATION_COPIED_ANNOUNCEMENT
					: INSTRUCTION_COPIED_ANNOUNCEMENT,
			);
		} catch {
			setCopied(null);
			setAnnouncement(COPY_FAILED_ANNOUNCEMENT);
		}
	};

	const configuration = rawKey ? buildMcpConfiguration(origin, rawKey) : null;
	const starterInstruction = buildStarterInstruction(projectName);
	const issueError = createKeyMutation.error;

	/**
	 * A live credential is on screen that exists nowhere else.
	 *
	 * Gated on `configurationCopied` and not on `rawKey` alone: the loss this
	 * guards against is losing the ONLY copy, and once the reader has taken one
	 * there is nothing left to lose. Trapping them past that point would be a
	 * modal that refuses to close for no remaining reason — worse for keyboard
	 * users than the accident it was meant to prevent.
	 */
	const uncopiedSecretOnScreen =
		configuration !== null && !configurationCopied;

	/**
	 * Disarm one incidental dismissal and say so.
	 *
	 * Escape, a click outside and a focus escape all reach a close through
	 * paths a reader can take by reflex. `Done` is left as the one exit,
	 * because it is the only one that cannot be pressed by accident.
	 */
	const guardDismissal = (event: { preventDefault: () => void }) => {
		if (!uncopiedSecretOnScreen) {
			return;
		}
		event.preventDefault();
		setAnnouncement(DISMISSAL_BLOCKED_ANNOUNCEMENT);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="max-w-2xl"
				// While the only copy of the key is on screen, the close (X)
				// button goes with the rest of the incidental exits: leaving it
				// would advertise a one-click way to destroy the secret right
				// next to the warning that says it cannot be retrieved.
				hideCloseButton={uncopiedSecretOnScreen}
				onEscapeKeyDown={guardDismissal}
				onPointerDownOutside={guardDismissal}
				onInteractOutside={guardDismissal}
				// Fires before the focus scope moves focus into the dialog, so
				// `activeElement` is still the control that opened it.
				onOpenAutoFocus={() => {
					invokerRef.current =
						document.activeElement instanceof HTMLElement
							? document.activeElement
							: null;
				}}
				onCloseAutoFocus={(event) => {
					const invoker = invokerRef.current;
					if (!invoker || !document.contains(invoker)) {
						// The opening control is gone — eligibility flipped
						// while the dialog was up, which is the ordinary case
						// after a key is issued. Leave Radix's own handling in
						// place rather than focusing a detached node.
						return;
					}
					event.preventDefault();
					invoker.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle className="font-serif font-normal text-2xl">
						{DIALOG_TITLE}
					</DialogTitle>
					<DialogDescription>{DIALOG_DESCRIPTION}</DialogDescription>
				</DialogHeader>

				{/* One polite live region for both copy controls. Kept mounted
				 * across state changes so assistive technology has something to
				 * observe rather than a node appearing mid-announcement. */}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>

				{configuration === null ? (
					<div className="space-y-4">
						{/* Section 1. Disclosure, above the create control, so
						 * nothing is minted before it has been read. */}
						<section
							aria-labelledby="connect-cli-disclosure-label"
							className="space-y-3 rounded-lg border border-border bg-muted/40 p-4"
						>
							<h3
								id="connect-cli-disclosure-label"
								className="app-editorial-label"
							>
								{DISCLOSURE_LABEL}
							</h3>
							<ul className="space-y-2 text-muted-foreground text-sm">
								{DISCLOSURE_POINTS.map((point) => (
									<li
										key={point}
										className="flex items-start gap-2"
									>
										<span
											aria-hidden="true"
											className="mt-2 size-1 shrink-0 rounded-full bg-primary"
										/>
										<span>{point}</span>
									</li>
								))}
							</ul>
						</section>

						{issueError ? (
							<Alert variant="error">
								<AlertTriangleIcon aria-hidden="true" />
								<AlertTitle>{ISSUE_ERROR_TITLE}</AlertTitle>
								{/* Always the fallback copy, never `issueError.message`:
								 * this repo is public, and a Prisma or driver
								 * message reaching this alert would paint an
								 * internal detail in front of any organization
								 * member who clicks create. The real error is
								 * logged in the mutation's `onError` instead. */}
								<AlertDescription>
									{ISSUE_ERROR_FALLBACK}
								</AlertDescription>
							</Alert>
						) : null}
					</div>
				) : (
					<div className="space-y-4">
						{/* Section 2. The finished configuration. */}
						<section
							aria-labelledby="connect-cli-configuration-label"
							className="space-y-3"
						>
							<h3
								id="connect-cli-configuration-label"
								className="app-editorial-label"
							>
								{CONFIGURATION_LABEL}
							</h3>
							<p className="text-muted-foreground text-sm">
								{CONFIGURATION_INTRO}
							</p>
							<pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 text-xs">
								<code data-testid="connect-cli-configuration">
									{configuration}
								</code>
							</pre>
							<Button
								ref={copyConfigurationRef}
								// Initial focus lands here, so the note below is
								// read out as this control's description — the
								// disarmed dismissals are announced before a
								// reader can discover them by pressing Escape.
								aria-describedby={
									uncopiedSecretOnScreen
										? "connect-cli-dismissal-note"
										: undefined
								}
								autoLoading={false}
								className="w-full"
								onClick={() =>
									copy("configuration", configuration)
								}
							>
								{copied === "configuration" ? (
									<>
										<CheckIcon aria-hidden="true" />
										{COPIED_LABEL}
									</>
								) : (
									<>
										<CopyIcon aria-hidden="true" />
										{COPY_CONFIGURATION_LABEL}
									</>
								)}
							</Button>
							{uncopiedSecretOnScreen ? (
								<p
									className="text-muted-foreground text-sm"
									data-testid="connect-cli-dismissal-note"
									id="connect-cli-dismissal-note"
								>
									{UNCOPIED_DISMISSAL_NOTE}
								</p>
							) : null}
							{/* Painted in the `--highlight` token pair rather
							 * than the primitive's `warning` variant, which
							 * reaches for a raw Tailwind yellow. */}
							<Alert className="border-highlight/40 bg-highlight/5 text-highlight-ink">
								<AlertTriangleIcon
									aria-hidden="true"
									className="text-highlight"
								/>
								<AlertTitle>{SHOWN_ONCE_TITLE}</AlertTitle>
								<AlertDescription>
									<p>{SHOWN_ONCE_BODY}</p>
									{/* The link is withheld until the
									 * configuration has been copied. It is a
									 * client-side navigation out of the page
									 * this dialog is mounted on, so following
									 * it unmounts the only holder of the
									 * plaintext key — the one exit the
									 * dismissal guards cannot intercept,
									 * because it is not a dismissal. Withheld
									 * rather than confirmed-on-click: the page
									 * it points at is still named in the prose
									 * either way, which is all this paragraph
									 * ever had to do, and the reader is spared
									 * a second modal on top of this one. */}
									<p className="mt-1">
										{organizationSlug &&
										configurationCopied ? (
											<>
												{REVOKE_LOCATION}{" "}
												<Link
													className="underline underline-offset-4"
													href={apiKeysSettingsPath(
														organizationSlug,
													)}
												>
													{REVOKE_LINK_LABEL}
												</Link>
											</>
										) : (
											REVOKE_LOCATION
										)}
									</p>
								</AlertDescription>
							</Alert>
						</section>

						{/* Section 3. The starter instruction. */}
						<section
							aria-labelledby="connect-cli-instruction-label"
							className="space-y-3"
						>
							<h3
								id="connect-cli-instruction-label"
								className="app-editorial-label"
							>
								{INSTRUCTION_LABEL}
							</h3>
							<p className="text-muted-foreground text-sm">
								{INSTRUCTION_INTRO}
							</p>
							<p
								className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
								data-testid="connect-cli-starter-instruction"
							>
								{starterInstruction}
							</p>
							<Button
								autoLoading={false}
								onClick={() =>
									copy("instruction", starterInstruction)
								}
								size="sm"
								variant="outline"
							>
								{copied === "instruction" ? (
									<>
										<CheckIcon aria-hidden="true" />
										{COPIED_LABEL}
									</>
								) : (
									<>
										<CopyIcon aria-hidden="true" />
										{COPY_INSTRUCTION_LABEL}
									</>
								)}
							</Button>
						</section>
					</div>
				)}

				<DialogFooter>
					{configuration === null ? (
						<>
							<Button
								autoLoading={false}
								onClick={() => handleOpenChange(false)}
								variant="outline"
							>
								{CANCEL_LABEL}
							</Button>
							{/* The ONLY place a key is minted. Never on open:
							 * a curious click must leave nothing behind. */}
							<Button
								autoLoading={false}
								loading={createKeyMutation.isPending}
								onClick={() => createKeyMutation.mutate()}
							>
								{createKeyMutation.isPending ? (
									CREATE_KEY_PENDING_LABEL
								) : (
									<>
										<KeyIcon aria-hidden="true" />
										{CREATE_KEY_LABEL}
									</>
								)}
							</Button>
						</>
					) : (
						<Button
							autoLoading={false}
							onClick={() => handleOpenChange(false)}
						>
							<PlugIcon aria-hidden="true" />
							{DONE_LABEL}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
