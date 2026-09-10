"use client";

import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import {
	createContext,
	type PropsWithChildren,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

type ConfirmOptions = {
	title: string;
	message?: string;
	cancelLabel?: string;
	confirmLabel?: string;
	destructive?: boolean;
	onConfirm: () => Promise<void> | void;
	/**
	 * An optional third action, rendered between Cancel and the primary.
	 *
	 * Exists so a destructive confirmation can offer the safe thing the user
	 * probably meant — "stop syncing" beside "delete the transcripts" — instead
	 * of only yes/no. When present it takes focus on open, so the reflex of
	 * hitting Enter on a dialog does the reversible thing (#2355).
	 */
	secondaryAction?: {
		label: string;
		onSelect: () => Promise<void> | void;
	};
	/**
	 * Require the person to type something exactly before the confirm button
	 * becomes usable — the organization's name, for instance (Fizzy #2462).
	 *
	 * Exists because a yes/no dialog only asks "are you sure", which a reflex
	 * answers. Typing the name asks "which one", which a reflex cannot. Reserve
	 * it for actions that destroy something a person cannot rebuild.
	 *
	 * The comparison is exact after trimming surrounding whitespace: a name is
	 * case-carrying, and accepting the wrong case would defeat the point of
	 * asking someone to look at it.
	 */
	requireTypedConfirmation?: {
		expected: string;
		label: ReactNode;
		placeholder?: string;
	};
};

// No default value: a `useConfirmationAlert()` outside the provider must throw
// rather than hand back a no-op `confirm` that silently swallows the action.
const ConfirmationAlertContext = createContext<{
	confirm: (options: ConfirmOptions) => void;
} | null>(null);

export function ConfirmationAlertProvider({ children }: PropsWithChildren) {
	const t = useTranslations();
	const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions | null>(
		null,
	);
	const [pending, setPending] = useState(false);
	const [typedConfirmation, setTypedConfirmation] = useState("");

	// Clear the typed value whenever the dialog opens on a NEW request. Without
	// this, dismissing the dialog and reopening it on a different target would
	// arrive with the previous answer already satisfying the gate — the one
	// failure mode that would make this control worse than no control.
	useEffect(() => {
		setTypedConfirmation("");
	}, [confirmOptions]);

	const typedConfirmationRequired =
		confirmOptions?.requireTypedConfirmation != null;
	const typedConfirmationSatisfied =
		!typedConfirmationRequired ||
		typedConfirmation.trim() ===
			confirmOptions?.requireTypedConfirmation?.expected;
	// Ref as well as state so the guard holds even if React has not re-rendered
	// between two clicks. `Button` already refuses re-entrant clicks while the
	// promise it returned is pending (`autoLoading`), so this is belt-and-braces
	// — it keeps the guarantee here rather than borrowing it from the primitive.
	const pendingRef = useRef(false);

	const confirm = useCallback((options: ConfirmOptions) => {
		setConfirmOptions(options);
	}, []);

	const handleSecondary = useCallback(async () => {
		if (pendingRef.current) {
			return;
		}
		pendingRef.current = true;
		setPending(true);
		try {
			await confirmOptions?.secondaryAction?.onSelect();
		} catch (error) {
			// Same contract as handleConfirm: callers own the toast, the dialog
			// must not be left open with a live button after a rejection.
			console.error("Confirmation secondary action failed", error);
		} finally {
			pendingRef.current = false;
			setPending(false);
			setConfirmOptions(null);
		}
	}, [confirmOptions]);

	const handleConfirm = useCallback(async () => {
		if (pendingRef.current) {
			return;
		}
		pendingRef.current = true;
		setPending(true);
		try {
			await confirmOptions?.onConfirm();
		} catch (error) {
			// Callers own user-facing error reporting — they all toast from the
			// mutation's `onError`. What must not happen is the dialog staying
			// open with a live confirm button while the rejection goes
			// unhandled, which is what it did before (#1905, D1).
			console.error("Confirmation action failed", error);
		} finally {
			pendingRef.current = false;
			setPending(false);
			setConfirmOptions(null);
		}
	}, [confirmOptions]);

	return (
		<ConfirmationAlertContext.Provider value={{ confirm }}>
			{children}

			<AlertDialog
				open={!!confirmOptions}
				onOpenChange={(open) => {
					// Never abandon an in-flight destructive action.
					if (!open && pendingRef.current) {
						return;
					}
					setConfirmOptions(open ? confirmOptions : null);
				}}
			>
				<AlertDialogContent
					// The three-action fork does not fit the default width.
					// Cancel plus a destructive label plus a safe-alternative
					// label runs past `max-w-lg`, and the footer is a grid item
					// that cannot shrink below its content, so the last button
					// overhung the card's right edge on staging (#2355). The
					// footer wraps as a backstop; widening is what keeps the
					// intended one-row reading order — cancel, destructive,
					// safe — instead of orphaning the safe action onto its own
					// line.
					className={
						confirmOptions?.secondaryAction
							? "sm:max-w-2xl"
							: undefined
					}
					onEscapeKeyDown={(event) => {
						if (pendingRef.current) {
							event.preventDefault();
						}
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirmOptions?.title}
						</AlertDialogTitle>
					</AlertDialogHeader>
					<AlertDialogDescription>
						{confirmOptions?.message}
					</AlertDialogDescription>

					{confirmOptions?.requireTypedConfirmation && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="confirmation-typed-value">
								{confirmOptions.requireTypedConfirmation.label}
							</Label>
							<Input
								id="confirmation-typed-value"
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="none"
								spellCheck={false}
								disabled={pending}
								placeholder={
									confirmOptions.requireTypedConfirmation
										.placeholder
								}
								value={typedConfirmation}
								onChange={(event) =>
									setTypedConfirmation(event.target.value)
								}
							/>
						</div>
					)}

					<AlertDialogFooter>
						{/* Radix element, not our `Button`, so it has no
						    autoLoading guard of its own. */}
						<AlertDialogCancel disabled={pending}>
							{confirmOptions?.cancelLabel ??
								t("common.confirmation.cancel")}
						</AlertDialogCancel>
						{/* Destructive is deliberately the PLAINER button when a
						    safe alternative exists: reachable, never reflexive.
						    Radix focuses Cancel by default, so the safe action
						    takes `autoFocus` explicitly — that is the property
						    the whole three-action shape exists for (#2355). */}
						<Button
							variant={
								confirmOptions?.secondaryAction
									? "outline"
									: confirmOptions?.destructive
										? "error"
										: "primary"
							}
							onClick={handleConfirm}
							disabled={pending || !typedConfirmationSatisfied}
						>
							{confirmOptions?.confirmLabel ??
								t("common.confirmation.confirm")}
						</Button>
						{confirmOptions?.secondaryAction && (
							<Button
								variant="primary"
								autoFocus
								onClick={handleSecondary}
								disabled={pending}
							>
								{confirmOptions.secondaryAction.label}
							</Button>
						)}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</ConfirmationAlertContext.Provider>
	);
}

export const useConfirmationAlert = () => {
	const context = useContext(ConfirmationAlertContext);

	if (!context) {
		throw new Error(
			"useConfirmationAlert must be used within a ConfirmationAlertProvider",
		);
	}

	return context;
};
