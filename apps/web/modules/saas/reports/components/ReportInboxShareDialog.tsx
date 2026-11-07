"use client";
import { useFullOrganizationQuery } from "@saas/organizations/lib/api";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
export function ReportInboxShareDialog({
	artifactId,
	artifactName,
	organizationId,
	onClose,
}: {
	artifactId: string;
	artifactName: string;
	organizationId: string;
	onClose: () => void;
}) {
	const { data: organization, isPending } =
		useFullOrganizationQuery(organizationId);
	const [selected, setSelected] = useState<string[]>([]);
	const [message, setMessage] = useState("");
	const [hash, setHash] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<{ fingerprint: string; id: string } | null>(null);
	useEffect(() => {
		let active = true;
		void orpcClient.reports.artifacts
			.download({ id: artifactId, organizationId })
			.then((result) => {
				if (active) {
					setHash(result.artifactHash);
					if (!result.artifactHash) {
						setError(
							"This output has no reviewable digest. Generate a new report edition before sharing.",
						);
					}
				}
			})
			.catch(() => {
				if (active) {
					setError(
						"The report could not be verified. Close this dialog and review the output again.",
					);
				}
			});
		return () => {
			active = false;
		};
	}, [artifactId, organizationId]);
	const share = async () => {
		if (!hash || busy || !selected.length) {
			return;
		}
		const fingerprint = JSON.stringify([
			hash,
			[...selected].sort(),
			message,
		]);
		if (request.current?.fingerprint !== fingerprint) {
			request.current = { fingerprint, id: crypto.randomUUID() };
		}
		setBusy(true);
		setError(null);
		try {
			const result = await orpcClient.reports.artifacts.distribute({
				artifactId,
				organizationId,
				requestId: request.current.id,
				expectedArtifactHash: hash,
				recipientUserIds: selected,
				message,
			});
			toast.success(
				`Shared to ${result.recipientCount} Fabric inbox${result.recipientCount === 1 ? "" : "es"}`,
			);
			onClose();
		} catch {
			setError(
				"Sharing was not confirmed. Check recipients’ report and project access, then retry. Your unchanged request will not create duplicate deliveries.",
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) {
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Share report to Fabric inboxes</DialogTitle>
					<DialogDescription>
						{artifactName}. Recipients must currently have report
						and project access. This action sends no external email.
					</DialogDescription>
				</DialogHeader>
				<fieldset disabled={busy} className="space-y-3">
					<legend className="text-sm font-medium">
						Choose recipients
					</legend>
					<div className="max-h-60 overflow-y-auto space-y-2">
						{isPending ? (
							<p role="status">Loading team members…</p>
						) : (
							(organization?.members ?? []).map((member) => (
								<label
									key={member.user.id}
									className="flex items-center gap-2 text-sm"
								>
									<input
										type="checkbox"
										checked={selected.includes(
											member.user.id,
										)}
										disabled={
											!selected.includes(
												member.user.id,
											) && selected.length >= 50
										}
										onChange={(event) =>
											setSelected((value) =>
												event.target.checked
													? [...value, member.user.id]
													: value.filter(
															(id) =>
																id !==
																member.user.id,
														),
											)
										}
									/>
									<span>
										{member.user.name || member.user.email}
									</span>
								</label>
							))
						)}
					</div>
					<label className="block text-sm">
						Note (optional)
						<textarea
							value={message}
							maxLength={1000}
							onChange={(event) => setMessage(event.target.value)}
							className="mt-1 block w-full rounded-md border p-2"
						/>
					</label>
				</fieldset>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				{!hash && !error && (
					<p role="status" className="text-sm">
						Verifying the exact saved output…
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						Cancel
					</Button>
					<Button
						disabled={busy || !hash || selected.length === 0}
						onClick={share}
					>
						{busy
							? "Sharing…"
							: `Share${selected.length ? ` with ${selected.length}` : ""}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
