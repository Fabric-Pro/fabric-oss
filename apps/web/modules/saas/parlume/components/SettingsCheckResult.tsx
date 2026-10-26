import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

/** The outcome of a settings test, announced to assistive technology. */
export function SettingsCheckResult({
	ok,
	message,
}: {
	ok: boolean;
	message: string;
}) {
	const Icon = ok ? CircleCheckIcon : CircleAlertIcon;
	return (
		<output
			className={`flex items-start gap-1.5 text-sm ${ok ? "text-success" : "text-destructive"}`}
		>
			<Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>{message}</span>
		</output>
	);
}
