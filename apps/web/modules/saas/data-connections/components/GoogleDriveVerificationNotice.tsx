import { InfoIcon } from "lucide-react";

export function GoogleDriveVerificationNotice() {
	return (
		<div
			role="status"
			aria-label="Google Drive verification notice"
			className="flex items-start gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-4 py-3"
		>
			<InfoIcon
				className="mt-0.5 h-4 w-4 shrink-0 text-highlight-ink"
				aria-hidden="true"
			/>
			<div className="flex-1 text-sm">
				<p className="font-medium text-highlight-ink">
					Google Drive access requires Google verification
				</p>
				<p className="mt-0.5 text-muted-foreground">
					To use Google Drive with Fabric, you must first complete
					Google’s verification process.
				</p>
			</div>
		</div>
	);
}
