"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
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
	"Create a key, connect your coding tool with it, and it can read this project's context while you work.";

/** Section 1 — what the key grants, said before anything is minted (R27). */
const DISCLOSURE_LABEL = "Before you create the key";

const DISCLOSURE_POINTS = [
	"The key authenticates as you. A tool holding it reads everything you can read in this organization — every project in it, not only this one.",
	"It is read-only: a tool holding it can read your work in Fabric, and cannot change it.",
	"It stays valid until you revoke it, or until it expires 90 days from now, whichever comes first.",
	"Both connection blocks shown next contain a live credential. Treat it like a password — do not paste it into a shared document, a ticket or a chat.",
] as const;

/**
 * The same four points, with the second one corrected for the one purpose whose
 * key can write something.
 *
 * A coding-instructions key carries `instructions:write`, so "it is read-only"
 * would be false for it. What that scope actually reaches is the proposal
 * path — a suggestion somebody with edit rights approves or rejects in the tab
 * — and nothing else, so the replacement says exactly that rather than
 * downgrading the promise to a vague one.
 */
const INSTRUCTIONS_DISCLOSURE_POINTS = [
	DISCLOSURE_POINTS[0],
	"It reads your work in Fabric and cannot change it, with one exception: a tool holding it can SUGGEST a change to this project's coding instructions. Suggestions are held for review and nothing is published until somebody who can edit them approves it.",
	DISCLOSURE_POINTS[2],
	DISCLOSURE_POINTS[3],
] as const;

function disclosurePointsFor(purpose: ConnectCliPurpose): readonly string[] {
	return purpose === "coding-instructions"
		? INSTRUCTIONS_DISCLOSURE_POINTS
		: DISCLOSURE_POINTS;
}

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
	"This is the only time the key is shown. Copy it now — it cannot be retrieved afterwards, and replacing it means creating another key.";

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

const COPY_COMMANDS_LABEL = "Copy commands";

const COMMANDS_COPIED_ANNOUNCEMENT = "Commands copied to the clipboard.";

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
	"Until you copy the key, Escape and clicking outside will not close this dialog, and the link to the settings page is held back — either would leave with the only copy of it. “Done” closes and discards the key whenever you choose.";

/** Read out when a dismissal is disarmed, so the blocked key press is not silent. */
const DISMISSAL_BLOCKED_ANNOUNCEMENT =
	"The key has not been copied yet, so the dialog stayed open. Copy it, or choose Done to close and discard the key.";

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
 * The local-checkout route. Shown only when this project's coding
 * instructions are authored in Fabric, and shown FIRST when it is.
 *
 * A repository-backed project's instructions arrive with `git pull`, so a
 * sync hook would be a second writer with no merge between them — the CLI
 * refuses that project outright, and offering it here would send the reader
 * to a command that says no.
 *
 * Two routes, not three steps. The files can reach the tool on disk (the
 * CLI copies them into the checkout and Claude Code reads them natively) or
 * live over MCP (the configuration plus the sentence). Both need the key
 * this dialog just created; neither needs the other. The dialog said the
 * MCP route first and tacked the command on as a muted sentence, and read
 * as three things to do in order. Now the checkout route leads, because it
 * is the one to pick for Claude Code, and the MCP route follows as the
 * alternative.
 *
 * The sign-in line carries the key on purpose: the CLI stores it in its own
 * per-user config and the hook it installs never names it, so this is the
 * one place the key has to be typed — and copying this block is copying the
 * key, which is why it satisfies the dismissal guard exactly as the
 * configuration does.
 */
const ROUTES_INTRO =
	"Two ways to give your tool these instructions. Use either; choose the coding tool you use in the checkout below.";

const LOCAL_SYNC_LABEL = "Recommended: keep the files in your checkout";

const LOCAL_SYNC_INTRO =
	"Run these once in the checkout. The first installs or updates the CLI. The second signs it in with this key and this deployment URL; the CLI keeps both in its own profile, never in the repository, though like any command the line may remain in your shell history. FABRIC_BASE_URL overrides the profile URL when it is set. The third copies whatever is published into the checkout and configures the session-start behavior below. If nothing is published yet, the hook checks for the first version at future session starts. Both tools read the files directly, so the sentence further down is not needed.";

type LocalSetupTool = "claude-code" | "codex";

const LOCAL_SETUP_TOOL_LABEL = "Choose your coding tool";

const CODEX_HOOK_TRUST_NOTE =
	"After you start Codex for the first time, use /hooks to review and trust the project hook.";

const APPLY_UPDATES_CHECKBOX_ID = "connect-cli-apply-published-updates";

const APPLY_UPDATES_DESCRIPTION_ID =
	"connect-cli-apply-published-updates-description";

const APPLY_UPDATES_LABEL =
	"Automatically apply published updates at session start";

const APPLY_UPDATES_DESCRIPTION =
	"By default, session-start checks only report published changes and print a command to apply them. Select this option to update local instruction files automatically.";

/** The MCP route's heading when it follows the checkout route. */
const MCP_ROUTE_LABEL = "Or read them live over MCP";

function buildLocalSyncCommands(
	projectId: string,
	rawKey: string,
	baseUrl: string,
	automaticallyApplyUpdates: boolean,
	tool: LocalSetupTool,
): string {
	return [
		"npm install -g @fabricorg/cli",
		`fabric auth login --key ${rawKey} --base-url ${baseUrl}`,
		`fabric instructions init --project ${projectId} --tool ${tool}${
			automaticallyApplyUpdates ? " --apply" : ""
		}`,
	].join("\n");
}

/**
 * Which entry point opened this dialog, so the one pasted sentence names the
 * thing that surface actually promised — full project context from the
 * project-level prompt/checklist, or specifically the published coding
 * instructions from the Coding Instructions tab. Everything else about the
 * dialog (the mint, the scopes, the configuration) is identical either way.
 */
export type ConnectCliPurpose = "project" | "coding-instructions";

/**
 * The one sentence a reader pastes into their coding tool.
 *
 * Deliberately one sentence and no more, for either purpose. The gateway
 * already ships a handshake `instructions` block to every client that
 * connects, and the tool descriptions chain the first calls themselves, so
 * re-teaching any of that here would spend the only sentence the reader will
 * actually paste on something they are being told twice.
 */
function buildStarterInstruction(
	projectName: string,
	purpose: ConnectCliPurpose,
): string {
	if (purpose === "coding-instructions") {
		return `Use the Fabric MCP server to load the published coding instructions for the project "${projectName}" and follow them while you help me work on it.`;
	}
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
 * The coding-instructions purpose also offers the CLI route, whose REST
 * routes require the exact `instructions:read` scope (`requireScope` in the
 * v1 middleware matches by name; the gateway's umbrella reading of
 * `mcp:read` does not apply there). A key minted for that purpose carries
 * it, so the command the dialog recommends works with the key it just
 * created.
 *
 * `instructions:write` is the one non-read scope this dialog ever mints, and
 * it is here because the CLI it configures now has `fabric instructions push`
 * and the MCP gateway has `fabric_propose_project_instruction_change`. Both
 * open a PROPOSAL: a suggestion held for review, published by nobody but a
 * person with edit rights in the tab.
 *
 * Publishing is not reachable from this scope at all — neither surface has a
 * publish mode to ask for — which is what makes the disclosure below true for
 * EVERY person who mints a key here. A mode gated on the minter's own
 * permissions would have made "nothing is published until somebody approves"
 * a half-truth for anyone holding `INSTRUCTION_CREATE`, and the sentence a
 * person reads before creating a credential has to hold whoever they are.
 * The key therefore stays within what a reader can already do in the browser,
 * which is also why `READ_ONLY_ORG_API_KEY_SCOPES` accepts it and a viewer's
 * mint is not clamped. `DISCLOSURE_POINTS` says so before the key is created.
 */
const ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS = [
	"mcp:read",
	"instructions:read",
	"instructions:write",
] as const;

type IssuedKeyScope = (typeof ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS)[number];

function issuedKeyScopes(purpose: ConnectCliPurpose): IssuedKeyScope[] {
	return purpose === "coding-instructions"
		? [...ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS]
		: [...ISSUED_KEY_SCOPES];
}

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

type CopyTarget = "configuration" | "instruction" | "command";

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
	 * Which entry point opened this dialog. Changes only the starter
	 * instruction's wording — the mint, the scopes, and the configuration are
	 * the same either way. Defaults to `"project"`, the original prompt/
	 * checklist wording, so every existing caller is unaffected.
	 */
	purpose?: ConnectCliPurpose;
	/**
	 * The project, named in the `fabric instructions init` line below. Only
	 * read on the coding-instructions purpose.
	 */
	projectId?: string;
	/**
	 * Whether this project's instructions can be kept current in a local
	 * checkout — true when Fabric is their source of truth, false when they
	 * come from the project's repository. Defaults to false so a caller that
	 * has not resolved the setting says nothing rather than saying something
	 * that will be refused.
	 */
	localSyncAvailable?: boolean;
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
	purpose = "project",
	projectId,
	localSyncAvailable = false,
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
	const [keyCopied, setKeyCopied] = useState(false);
	const [automaticallyApplyUpdates, setAutomaticallyApplyUpdates] =
		useState(false);
	const [localSetupTool, setLocalSetupTool] =
		useState<LocalSetupTool>("claude-code");
	const [announcement, setAnnouncement] = useState("");
	const [origin, setOrigin] = useState("");
	const initialFocusRef = useRef<HTMLButtonElement>(null);
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
				scopes: issuedKeyScopes(purpose),
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
			initialFocusRef.current?.focus();
		}
	}, [rawKey]);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			// The secret is gone from the client as soon as this view closes,
			// which is the honest reflection of the warning it just showed.
			setRawKey(null);
			setCopied(null);
			setKeyCopied(false);
			setAutomaticallyApplyUpdates(false);
			setLocalSetupTool("claude-code");
			setAnnouncement("");
			createKeyMutation.reset();
		}
		onOpenChange(nextOpen);
	};

	const copy = async (target: CopyTarget, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(target);
			// Both blocks carry the key; taking either is taking the key.
			if (target === "configuration" || target === "command") {
				setKeyCopied(true);
			}
			setAnnouncement(
				target === "configuration"
					? CONFIGURATION_COPIED_ANNOUNCEMENT
					: target === "instruction"
						? INSTRUCTION_COPIED_ANNOUNCEMENT
						: COMMANDS_COPIED_ANNOUNCEMENT,
			);
		} catch {
			setCopied(null);
			setAnnouncement(COPY_FAILED_ANNOUNCEMENT);
		}
	};

	const configuration = rawKey ? buildMcpConfiguration(origin, rawKey) : null;
	const starterInstruction = buildStarterInstruction(projectName, purpose);
	const localSyncCommands =
		purpose === "coding-instructions" &&
		localSyncAvailable &&
		projectId &&
		rawKey
			? buildLocalSyncCommands(
					projectId,
					rawKey,
					window.location.origin,
					automaticallyApplyUpdates,
					localSetupTool,
				)
			: null;
	const cliFirst = localSyncCommands !== null;
	const issueError = createKeyMutation.error;

	/**
	 * A live credential is on screen that exists nowhere else.
	 *
	 * Gated on `keyCopied` and not on `rawKey` alone: the loss this
	 * guards against is losing the ONLY copy, and once the reader has taken one
	 * there is nothing left to lose. Trapping them past that point would be a
	 * modal that refuses to close for no remaining reason — worse for keyboard
	 * users than the accident it was meant to prevent.
	 */
	const uncopiedSecretOnScreen = configuration !== null && !keyCopied;

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

	/**
	 * The once-only warning and the disarmed-dismissal note, rendered under
	 * whichever block shows the key FIRST: the commands when the checkout
	 * route leads, the configuration otherwise. One copy of each, because
	 * they are about the key, not about a block.
	 */
	const keyNotice = (
		<>
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
						{organizationSlug && keyCopied ? (
							<>
								{REVOKE_LOCATION}{" "}
								<Link
									className="underline underline-offset-4"
									href={apiKeysSettingsPath(organizationSlug)}
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
		</>
	);

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
					<div className="min-w-0 space-y-4">
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
								{disclosurePointsFor(purpose).map((point) => (
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
					<div className="min-w-0 space-y-4">
						{cliFirst ? (
							<p className="text-muted-foreground text-sm">
								{ROUTES_INTRO}
							</p>
						) : null}

						{/* The checkout route, first when it applies. */}
						{localSyncCommands ? (
							<section
								aria-labelledby="connect-cli-local-sync-label"
								className="space-y-3"
							>
								<h3
									id="connect-cli-local-sync-label"
									className="app-editorial-label"
								>
									{LOCAL_SYNC_LABEL}
								</h3>
								<p className="text-muted-foreground text-sm">
									{LOCAL_SYNC_INTRO}
								</p>
								<div className="space-y-2">
									<p
										className="text-sm font-medium"
										id="connect-cli-tool-label"
									>
										{LOCAL_SETUP_TOOL_LABEL}
									</p>
									<RadioGroup
										aria-labelledby="connect-cli-tool-label"
										className="flex gap-4"
										onValueChange={(value) => {
											if (
												value === "claude-code" ||
												value === "codex"
											) {
												setLocalSetupTool(value);
												setCopied(null);
												setAnnouncement("");
											}
										}}
										value={localSetupTool}
									>
										<div className="flex items-center gap-2">
											<RadioGroupItem
												id="connect-cli-tool-claude-code"
												value="claude-code"
											/>
											<Label htmlFor="connect-cli-tool-claude-code">
												Claude Code
											</Label>
										</div>
										<div className="flex items-center gap-2">
											<RadioGroupItem
												id="connect-cli-tool-codex"
												value="codex"
											/>
											<Label htmlFor="connect-cli-tool-codex">
												Codex
											</Label>
										</div>
									</RadioGroup>
								</div>
								{localSetupTool === "codex" ? (
									<p className="text-muted-foreground text-sm">
										{CODEX_HOOK_TRUST_NOTE}
									</p>
								) : null}
								<div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
									<Checkbox
										aria-describedby={
											APPLY_UPDATES_DESCRIPTION_ID
										}
										checked={automaticallyApplyUpdates}
										id={APPLY_UPDATES_CHECKBOX_ID}
										onCheckedChange={(checked) => {
											setAutomaticallyApplyUpdates(
												checked === true,
											);
											setCopied(null);
											setAnnouncement("");
										}}
									/>
									<div className="flex flex-col gap-1">
										<Label
											className="cursor-pointer"
											htmlFor={APPLY_UPDATES_CHECKBOX_ID}
										>
											{APPLY_UPDATES_LABEL}
										</Label>
										<p
											className="text-muted-foreground text-sm"
											id={APPLY_UPDATES_DESCRIPTION_ID}
										>
											{APPLY_UPDATES_DESCRIPTION}
										</p>
									</div>
								</div>
								{/* Wraps rather than scrolls: a line longer
								 * than the dialog is wide would otherwise hide
								 * its end behind a scrollbar — the project id,
								 * exactly where it stops being obvious.
								 * `min-w-0` on the wrapper above is what keeps
								 * a block like this from widening the dialog's
								 * grid column and clipping every paragraph. */}
								<pre
									className="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 font-mono text-xs"
									data-testid="connect-cli-local-sync-command"
								>
									{localSyncCommands}
								</pre>
								<Button
									ref={initialFocusRef}
									aria-describedby={
										uncopiedSecretOnScreen
											? "connect-cli-dismissal-note"
											: undefined
									}
									autoLoading={false}
									className="w-full"
									onClick={() =>
										copy("command", localSyncCommands)
									}
								>
									{copied === "command" ? (
										<>
											<CheckIcon aria-hidden="true" />
											{COPIED_LABEL}
										</>
									) : (
										<>
											<CopyIcon aria-hidden="true" />
											{COPY_COMMANDS_LABEL}
										</>
									)}
								</Button>
								{keyNotice}
							</section>
						) : null}

						{/* The MCP route: the configuration, then the sentence. */}
						<section
							aria-labelledby="connect-cli-configuration-label"
							className="space-y-3"
						>
							<h3
								id="connect-cli-configuration-label"
								className="app-editorial-label"
							>
								{cliFirst
									? MCP_ROUTE_LABEL
									: CONFIGURATION_LABEL}
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
								ref={cliFirst ? undefined : initialFocusRef}
								// Initial focus lands on the first copy control,
								// so the note below is read out as that
								// control's description — the disarmed
								// dismissals are announced before a reader can
								// discover them by pressing Escape.
								aria-describedby={
									uncopiedSecretOnScreen && !cliFirst
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
							{cliFirst ? null : keyNotice}
						</section>

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
