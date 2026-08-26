"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface BackupCodesDisplayProps {
	codes: string[];
	onSavedChange: (saved: boolean) => void;
	saved: boolean;
}

export function BackupCodesDisplay({
	codes,
	onSavedChange,
	saved,
}: BackupCodesDisplayProps) {
	const t = useTranslations();

	const codesText = codes.join("\n");

	const handleCopy = async () => {
		await navigator.clipboard.writeText(codesText);
		toast.success(
			t(
				"settings.account.security.twoFactor.backupCodes.saveDialog.copied",
			),
		);
	};

	const handleDownload = () => {
		const blob = new Blob([codesText], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "fabric-backup-codes.txt";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex flex-col gap-4">
			<section
				aria-label={t(
					"settings.account.security.twoFactor.backupCodes.saveDialog.codesRegion",
				)}
			>
				<pre className="bg-muted rounded-md p-4 text-sm font-mono leading-relaxed select-all whitespace-pre-line">
					{codesText}
				</pre>
			</section>

			<div className="flex gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={handleCopy}
				>
					<CopyIcon className="mr-1.5 size-4" />
					{t(
						"settings.account.security.twoFactor.backupCodes.saveDialog.copy",
					)}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={handleDownload}
				>
					<DownloadIcon className="mr-1.5 size-4" />
					{t(
						"settings.account.security.twoFactor.backupCodes.saveDialog.download",
					)}
				</Button>
			</div>

			<div className="flex items-center gap-2">
				<Checkbox
					id="backup-codes-saved"
					checked={saved}
					onCheckedChange={(checked) =>
						onSavedChange(checked === true)
					}
				/>
				<Label htmlFor="backup-codes-saved" className="cursor-pointer">
					{t(
						"settings.account.security.twoFactor.backupCodes.saveDialog.saved",
					)}
				</Label>
			</div>
		</div>
	);
}
