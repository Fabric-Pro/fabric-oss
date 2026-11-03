"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Switch } from "@ui/components/switch";
import { useState } from "react";

export function NewsletterOrgDistributionSetting({
	checked,
	disabled,
	syncError,
	onChange,
}: {
	checked: boolean;
	disabled: boolean;
	syncError: string | null;
	onChange: (next: boolean) => void;
}) {
	const [pending, setPending] = useState<boolean | null>(null);

	return (
		<div className="rounded-lg border border-border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						Send to entire organization
					</p>
					<p className="break-words text-sm text-muted-foreground">
						Add everyone in this organization to the subscriber list
						before each send. People who unsubscribed stay
						unsubscribed.
					</p>
				</div>
				<Switch
					checked={checked}
					disabled={disabled}
					aria-label="Send to entire organization"
					onCheckedChange={setPending}
				/>
			</div>
			{syncError && (
				<p role="alert" className="mt-2 text-destructive text-sm">
					The last organization sync failed, so this list may be out
					of date: {syncError}
				</p>
			)}
			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPending(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pending
								? "Send to the entire organization?"
								: "Stop sending to the entire organization?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pending
								? "From the next send, everyone in this organization receives these release notes."
								: "This removes everyone it added, along with any exclusions. People added by hand stay on the list."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pending !== null) {
									onChange(pending);
								}
							}}
						>
							{pending ? "Turn on" : "Turn off"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
