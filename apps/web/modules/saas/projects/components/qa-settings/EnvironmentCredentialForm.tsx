"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { KeyRoundIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * How a Fabric-driven test run signs in to one deployment target.
 *
 * Lives in its own file rather than inside `ProjectEnvironmentsSettings`, which
 * is already 500+ lines; a credential editor with four modes does not belong
 * inline in a list row.
 *
 * **The secret is write-only, and the UI has to make that legible.** The server
 * returns only whether a secret exists and when it was last written, so this
 * never renders a password — not even a masked one, which would imply the value
 * came back. An existing credential shows "Stored ·  <date>" and the input stays
 * empty with a placeholder saying that leaving it blank keeps what is stored.
 * That is also the actual API contract: omitting `secret` preserves it.
 */

type AuthKind = "NONE" | "FORM" | "TOKEN" | "HEADER";

const KIND_LABEL: Record<AuthKind, string> = {
	NONE: "No sign-in needed",
	FORM: "Username and password",
	TOKEN: "Bearer token",
	HEADER: "Custom header",
};

const KIND_HINT: Record<AuthKind, string> = {
	NONE: "The runner opens the environment directly. Use this for a public or already-open environment.",
	FORM: "The runner types these into your app's sign-in form.",
	TOKEN: "Sent as `Authorization: Bearer …` on every request the run makes.",
	HEADER: "Sent as your own header on every request, e.g. `X-API-Key`.",
};

const KINDS = Object.keys(KIND_LABEL) as AuthKind[];

export interface EnvironmentCredentialSummary {
	environmentId: string;
	authKind: AuthKind;
	authUsername: string | null;
	authHeaderName: string | null;
	hasSecret: boolean;
	authUpdatedAt: string | Date | null;
}

export function EnvironmentCredentialForm({
	projectId,
	environmentId,
	environmentName,
	isProduction,
	baseUrl,
	signInUrl,
	summary,
	canEdit,
	onDone,
}: {
	projectId: string;
	environmentId: string;
	environmentName: string;
	isProduction: boolean;
	/** The environment's base URL, shown as the fallback in the hint below. */
	baseUrl: string;
	/** Where the sign-in form lives, when it is not at the base URL. */
	signInUrl: string | null;
	summary?: EnvironmentCredentialSummary;
	canEdit: boolean;
	onDone?: () => void;
}) {
	const queryClient = useQueryClient();

	const [authKind, setAuthKind] = useState<AuthKind>(
		summary?.authKind ?? "NONE",
	);
	const [username, setUsername] = useState(summary?.authUsername ?? "");
	const [headerName, setHeaderName] = useState(summary?.authHeaderName ?? "");
	/** Empty means "leave the stored secret alone" — never "clear it". */
	const [secret, setSecret] = useState("");
	/**
	 * Empty means "the form is at the base URL", which is what the runner assumed
	 * before this field existed. Saved on the ENVIRONMENT rather than the
	 * credential — it is a fact about the app, not about who signs in — but edited
	 * here, because this is where someone configuring form sign-in is looking.
	 */
	const [signInUrlDraft, setSignInUrlDraft] = useState(signInUrl ?? "");

	const hasStoredSecret = summary?.hasSecret ?? false;

	const saveMutation = useMutation(
		orpc.projects.environments.credentials.set.mutationOptions({
			onSuccess: () => {
				toast.success("Sign-in credential saved");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.environments.credentials.list.key(),
				});
				setSecret("");
				onDone?.();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	/**
	 * The sign-in URL lives on the ENVIRONMENT, not the credential, so saving it
	 * is a second mutation. Fired only when it actually changed — a credential
	 * save should not rewrite the environment row every time.
	 */
	const environmentMutation = useMutation(
		orpc.projects.environments.update.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.environments.list.key(),
				});
			},
			// Reported rather than swallowed: the credential saving while the URL
			// silently did not is exactly the state that makes a later sign-in
			// failure baffling.
			onError: (error) =>
				toast.error(`Sign-in page not saved: ${error.message}`),
		}),
	);

	const submit = () => {
		if (authKind === "FORM" && username.trim().length === 0) {
			toast.error("Form sign-in needs a username or email address.");
			return;
		}
		if (authKind === "HEADER" && headerName.trim().length === 0) {
			toast.error("Header auth needs a header name, e.g. X-API-Key.");
			return;
		}
		// A kind that needs a secret and has neither a stored one nor a typed one
		// cannot sign in. Caught here so the failure is a sentence now rather than
		// a stuck login page during a run.
		if (
			authKind !== "NONE" &&
			!hasStoredSecret &&
			secret.trim().length === 0
		) {
			toast.error(
				authKind === "FORM"
					? "Enter a password."
					: "Enter the token or header value.",
			);
			return;
		}

		if (signInUrlDraft.trim() !== (signInUrl ?? "")) {
			environmentMutation.mutate({
				projectId,
				environmentId,
				// "" clears it server-side, which is how the blank field means
				// "the form is at the base URL".
				signInUrl: signInUrlDraft.trim(),
			});
		}

		saveMutation.mutate({
			projectId,
			environmentId,
			authKind,
			authUsername: authKind === "FORM" ? username.trim() : null,
			authHeaderName: authKind === "HEADER" ? headerName.trim() : null,
			// Omitted entirely when blank, which is what preserves the stored
			// secret server-side. Sending "" would CLEAR it.
			...(secret.trim().length > 0 ? { secret } : {}),
		});
	};

	const needsSecret = authKind !== "NONE";

	return (
		<div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
			<div className="flex items-center gap-1.5">
				<KeyRoundIcon
					className="size-3.5 text-muted-foreground"
					aria-hidden="true"
				/>
				<Label className="font-medium text-sm">
					Sign-in for {environmentName}
				</Label>
			</div>

			{isProduction && (
				<p className="flex items-start gap-1.5 text-highlight text-xs">
					<TriangleAlertIcon
						className="mt-0.5 size-3.5 shrink-0"
						aria-hidden="true"
					/>
					{/*
					 * Said at the point of entry, not only at dispatch. Storing a
					 * production credential is allowed — it is the customer's call —
					 * but they should be told what it means while typing it, not
					 * afterwards.
					 */}
					<span>
						This is a production environment. A run will sign in and
						act on your live system, and Fabric will warn but not
						stop it. Store this credential only if that is what you
						want.
					</span>
				</p>
			)}

			<div className="space-y-1">
				<Label htmlFor={`auth-kind-${environmentId}`}>Method</Label>
				<Select
					value={authKind}
					onValueChange={(v) => setAuthKind(v as AuthKind)}
					disabled={!canEdit || saveMutation.isPending}
				>
					<SelectTrigger id={`auth-kind-${environmentId}`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{KINDS.map((kind) => (
							<SelectItem key={kind} value={kind}>
								{KIND_LABEL[kind]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					{KIND_HINT[authKind]}
				</p>
			</div>

			{authKind === "FORM" && (
				<>
					<div className="space-y-1">
						<Label htmlFor={`auth-username-${environmentId}`}>
							Username or email
						</Label>
						<Input
							id={`auth-username-${environmentId}`}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							disabled={!canEdit || saveMutation.isPending}
							autoComplete="off"
						/>
					</div>

					<div className="space-y-1">
						<Label htmlFor={`sign-in-url-${environmentId}`}>
							Sign-in page{" "}
							<span className="font-normal text-muted-foreground">
								(optional)
							</span>
						</Label>
						<Input
							id={`sign-in-url-${environmentId}`}
							value={signInUrlDraft}
							onChange={(e) => setSignInUrlDraft(e.target.value)}
							placeholder={`${baseUrl.replace(/\/$/, "")}/login`}
							disabled={!canEdit || saveMutation.isPending}
							autoComplete="off"
							className="font-mono text-xs"
						/>
						<p className="text-muted-foreground text-xs">
							Leave blank if the form is at the base URL. Set it
							when your app has a marketing page or a separate
							login host in front of it — the runner signs in
							here, then goes to the base URL to run the case.
						</p>
					</div>
				</>
			)}

			{authKind === "HEADER" && (
				<div className="space-y-1">
					<Label htmlFor={`auth-header-${environmentId}`}>
						Header name
					</Label>
					<Input
						id={`auth-header-${environmentId}`}
						value={headerName}
						onChange={(e) => setHeaderName(e.target.value)}
						placeholder="X-API-Key"
						disabled={!canEdit || saveMutation.isPending}
						autoComplete="off"
					/>
				</div>
			)}

			{needsSecret && (
				<div className="space-y-1">
					<Label htmlFor={`auth-secret-${environmentId}`}>
						{authKind === "FORM" ? "Password" : "Value"}
					</Label>
					<Input
						id={`auth-secret-${environmentId}`}
						type="password"
						value={secret}
						onChange={(e) => setSecret(e.target.value)}
						placeholder={
							hasStoredSecret
								? "Leave blank to keep the stored value"
								: undefined
						}
						disabled={!canEdit || saveMutation.isPending}
						autoComplete="new-password"
						aria-describedby={`auth-secret-note-${environmentId}`}
					/>
					<p
						id={`auth-secret-note-${environmentId}`}
						className="text-muted-foreground text-xs"
					>
						{hasStoredSecret ? (
							<>
								Stored
								{summary?.authUpdatedAt
									? ` · updated ${new Date(summary.authUpdatedAt).toLocaleDateString()}`
									: ""}
								. Encrypted at rest; Fabric never shows it
								again.
							</>
						) : (
							"Encrypted at rest. Fabric never shows it again once saved."
						)}
					</p>
				</div>
			)}

			{authKind === "NONE" && hasStoredSecret && (
				<p className="text-muted-foreground text-xs">
					Saving with no sign-in method will{" "}
					<span className="font-medium">
						delete the stored secret
					</span>
					.
				</p>
			)}

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					onClick={submit}
					disabled={!canEdit || saveMutation.isPending}
				>
					{saveMutation.isPending && (
						<Loader2Icon
							className="mr-1.5 size-3.5 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					)}
					Save credential
				</Button>
				{onDone && (
					<Button
						size="sm"
						variant="ghost"
						onClick={onDone}
						disabled={saveMutation.isPending}
					>
						Cancel
					</Button>
				)}
			</div>

			{!canEdit && (
				<p className="text-muted-foreground text-xs">
					Only project admins can change sign-in credentials.
				</p>
			)}
		</div>
	);
}
