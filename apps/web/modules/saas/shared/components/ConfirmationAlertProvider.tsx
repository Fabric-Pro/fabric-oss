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
import { useTranslations } from "next-intl";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
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
	// Ref as well as state so the guard holds even if React has not re-rendered
	// between two clicks. `Button` already refuses re-entrant clicks while the
	// promise it returned is pending (`autoLoading`), so this is belt-and-braces
	// — it keeps the guarantee here rather than borrowing it from the primitive.
	const pendingRef = useRef(false);

	const confirm = useCallback((options: ConfirmOptions) => {
		setConfirmOptions(options);
	}, []);

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

					<AlertDialogFooter>
						{/* Radix element, not our `Button`, so it has no
						    autoLoading guard of its own. */}
						<AlertDialogCancel disabled={pending}>
							{confirmOptions?.cancelLabel ??
								t("common.confirmation.cancel")}
						</AlertDialogCancel>
						<Button
							variant={
								confirmOptions?.destructive
									? "error"
									: "primary"
							}
							onClick={handleConfirm}
						>
							{confirmOptions?.confirmLabel ??
								t("common.confirmation.confirm")}
						</Button>
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
