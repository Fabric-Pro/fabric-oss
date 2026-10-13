"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Link2Icon, Loader2Icon } from "lucide-react";
import {
	type FormEvent,
	type ReactElement,
	useEffect,
	useId,
	useState,
} from "react";

/** The dialog's words; each caller supplies its own (translated or not). */
export interface LinkPmItemDialogCopy {
	title: string;
	description: string;
	label: string;
	placeholder: string;
	submit: string;
	cancel: string;
}

/**
 * "Link to existing item": one field for the PM item's id or key and a
 * submit. Shared by the story failure panel and the test-case PM-sync
 * controls. `onSubmit` links the item; when it rejects, the dialog stays open
 * and shows the server's message under the field. On success it closes.
 *
 * Focus: `trigger` is the button that opens it, rendered as the dialog's
 * `DialogTrigger`; the dialog moves focus to the field when it opens and
 * Radix returns it to that button when the dialog is dismissed (Cancel,
 * Escape or a click outside).
 */
export function LinkPmItemDialog({
	open,
	onOpenChange,
	onSubmit,
	copy,
	trigger,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (externalId: string) => Promise<unknown>;
	copy: LinkPmItemDialogCopy;
	trigger: ReactElement;
}) {
	const fieldId = useId();
	const errorId = `${fieldId}-error`;
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	// Start empty each time it opens.
	useEffect(() => {
		if (open) {
			setValue("");
			setError(null);
			setPending(false);
		}
	}, [open]);

	const trimmed = value.trim();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!trimmed || pending) {
			return;
		}
		setPending(true);
		setError(null);
		try {
			await onSubmit(trimmed);
			onOpenChange(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!pending) {
					onOpenChange(next);
				}
			}}
		>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="max-w-md">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{copy.title}</DialogTitle>
						<DialogDescription>
							{copy.description}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor={fieldId}>{copy.label}</Label>
						<Input
							id={fieldId}
							value={value}
							placeholder={copy.placeholder}
							maxLength={200}
							autoComplete="off"
							autoFocus
							onChange={(e) => {
								setValue(e.target.value);
								if (error) {
									setError(null);
								}
							}}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? errorId : undefined}
						/>
						{error && (
							<p
								id={errorId}
								role="alert"
								className="text-destructive text-xs"
							>
								{error}
							</p>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={pending}
						>
							{copy.cancel}
						</Button>
						<Button type="submit" disabled={!trimmed || pending}>
							{pending ? (
								<Loader2Icon
									className="mr-2 size-4 animate-spin"
									aria-hidden="true"
								/>
							) : (
								<Link2Icon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
							)}
							{copy.submit}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
