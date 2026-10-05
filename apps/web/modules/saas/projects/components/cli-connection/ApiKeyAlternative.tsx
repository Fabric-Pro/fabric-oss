"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, KeyIcon } from "lucide-react";
import Link from "next/link";
import type { Ref } from "react";
import { CodeBlock } from "./CommandBlock";
import { DisclosureRow } from "./DisclosureRow";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Every user-visible sentence lives here rather than inline in the JSX, so the */
/* wording that needs product sign-off is reviewable in one place.              */
/* -------------------------------------------------------------------------- */

/**
 * The API-key route, kept for CI and headless machines where nobody can
 * approve a sign-in in a browser.
 */
const KEY_ALTERNATIVE_LABEL = "CI or headless? Use an API key";

/** Said before anything is minted: what the key grants is in the cards above it. */
const PASSWORD_NOTE =
	"Treat the key like a password: keep it out of shared documents, tickets and chats.";

const CREATE_KEY_LABEL = "Create key";

const CREATE_KEY_PENDING_LABEL = "Creating key…";

const ISSUE_ERROR_TITLE = "The key could not be created";

const ISSUE_ERROR_FALLBACK =
	"Something went wrong creating the key. Try again, or create one from the organization's API keys settings.";

const SHOWN_ONCE_TITLE = "Shown once";

const SHOWN_ONCE_BODY =
	"Copy the key now: it cannot be retrieved afterwards, and replacing it means creating another key. Do not paste it into a shared document, a ticket or a chat.";

const REVOKE_LOCATION =
	"You can review this key, see when it was last used, or revoke it on the organization's API keys settings page.";

const REVOKE_LINK_LABEL = "API keys settings";

const COPY_CONFIGURATION_LABEL = "Copy configuration";

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

const DISMISSAL_NOTE_ID = "connect-cli-dismissal-note";

/** One of the three cards that say what a key can do, before it is created. */
export interface KeyFact {
	label: string;
	value: string;
}

/**
 * The once-only warning and, while the key is uncopied, the disarmed-dismissal
 * note. It is about the KEY, not about the configuration under it, so it has
 * exactly one home.
 */
function KeyNotice({
	uncopiedSecretOnScreen,
	keyCopied,
	organizationSlug,
}: {
	uncopiedSecretOnScreen: boolean;
	keyCopied: boolean;
	organizationSlug?: string;
}) {
	return (
		<>
			{uncopiedSecretOnScreen ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid={DISMISSAL_NOTE_ID}
					id={DISMISSAL_NOTE_ID}
				>
					{UNCOPIED_DISMISSAL_NOTE}
				</p>
			) : null}
			{/* Painted in the `--highlight` token pair rather than the primitive's
			 * `warning` variant, which reaches for a raw Tailwind yellow. */}
			<Alert className="border-highlight/40 bg-highlight/5 text-highlight-ink">
				<AlertTriangleIcon
					aria-hidden="true"
					className="text-highlight"
				/>
				<AlertTitle>{SHOWN_ONCE_TITLE}</AlertTitle>
				<AlertDescription>
					<p>{SHOWN_ONCE_BODY}</p>
					{/* The link is withheld until the configuration has been copied.
					 * It is a client-side navigation out of the page this dialog is
					 * mounted on, so following it unmounts the only holder of the
					 * plaintext key — the one exit the dismissal guards cannot
					 * intercept, because it is not a dismissal. Withheld rather than
					 * confirmed-on-click: the page it points at is still named in the
					 * prose either way, which is all this paragraph ever had to do. */}
					<p className="mt-1">
						{organizationSlug && keyCopied ? (
							<>
								{REVOKE_LOCATION}{" "}
								<Link
									className="underline underline-offset-4"
									href={`/app/${organizationSlug}/settings/api-keys`}
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
}

/**
 * The API-key route: three facts about the key, the create control, and — once
 * a key exists — its once-only notice and the configuration that carries it.
 *
 * Presentational. The key, the mint and the dismissal guard belong to the
 * dialog, which has to keep the secret outside anything a toggle can unmount.
 * The row stays in the DOM while closed, and `open` is forced by the dialog
 * while a key is on screen, so the guard is never hiding behind a closed row.
 */
export function ApiKeyAlternative({
	facts,
	open,
	onOpenChange,
	keyIssued,
	creating,
	createFailed,
	onCreate,
	configuration,
	configurationCopied,
	onCopyConfiguration,
	copyButtonRef,
	uncopiedSecretOnScreen,
	keyCopied,
	organizationSlug,
}: {
	facts: readonly KeyFact[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	keyIssued: boolean;
	creating: boolean;
	createFailed: boolean;
	onCreate: () => void;
	configuration: string;
	configurationCopied: boolean;
	onCopyConfiguration: () => void;
	/** Takes initial focus once the configuration appears. */
	copyButtonRef: Ref<HTMLButtonElement>;
	uncopiedSecretOnScreen: boolean;
	keyCopied: boolean;
	organizationSlug?: string;
}) {
	return (
		<DisclosureRow
			icon={KeyIcon}
			label={KEY_ALTERNATIVE_LABEL}
			onOpenChange={onOpenChange}
			open={open}
			testId="connect-cli-key-alternative"
		>
			<dl className="grid gap-2 sm:grid-cols-3">
				{facts.map((fact) => (
					<div
						className="rounded-lg border border-border bg-muted/40 p-2.5"
						key={fact.label}
					>
						<dt className="fab-label">{fact.label}</dt>
						<dd className="mt-1 text-sm leading-snug">
							{fact.value}
						</dd>
					</div>
				))}
			</dl>

			{keyIssued ? (
				<>
					<KeyNotice
						keyCopied={keyCopied}
						organizationSlug={organizationSlug}
						uncopiedSecretOnScreen={uncopiedSecretOnScreen}
					/>
					<CodeBlock
						copied={configurationCopied}
						copyButtonRef={copyButtonRef}
						// Initial focus lands on this copy control once a key
						// exists, so the note is read out as its description — the
						// disarmed dismissals are announced before a reader can
						// discover them by pressing Escape.
						copyDescribedBy={
							uncopiedSecretOnScreen
								? DISMISSAL_NOTE_ID
								: undefined
						}
						copyLabel={COPY_CONFIGURATION_LABEL}
						layout="document"
						onCopy={onCopyConfiguration}
						testId="connect-cli-configuration"
						text={configuration}
					/>
				</>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
						<p className="min-w-0 flex-1 text-muted-foreground text-xs">
							{PASSWORD_NOTE}
						</p>
						{/* The ONLY place a key is minted. Never on open: a curious
						 * click must leave nothing behind. */}
						<Button
							autoLoading={false}
							loading={creating}
							onClick={onCreate}
							size="sm"
							variant="outline"
						>
							{creating ? (
								CREATE_KEY_PENDING_LABEL
							) : (
								<>
									<KeyIcon aria-hidden="true" />
									{CREATE_KEY_LABEL}
								</>
							)}
						</Button>
					</div>
					{createFailed ? (
						<Alert variant="error">
							<AlertTriangleIcon aria-hidden="true" />
							<AlertTitle>{ISSUE_ERROR_TITLE}</AlertTitle>
							{/* Always the fallback copy, never the error's message:
							 * this repo is public, and a Prisma or driver message
							 * reaching this alert would paint an internal detail in
							 * front of any organization member who clicks create.
							 * The real error is logged by the dialog instead. */}
							<AlertDescription>
								{ISSUE_ERROR_FALLBACK}
							</AlertDescription>
						</Alert>
					) : null}
				</>
			)}
		</DisclosureRow>
	);
}
