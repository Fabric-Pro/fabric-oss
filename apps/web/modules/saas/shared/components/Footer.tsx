import { LocaleLink } from "@i18n/routing";
import { cn } from "@ui/lib";

export function Footer() {
	return (
		<footer
			className={cn(
				"container max-w-6xl py-6 text-center text-foreground/60 text-xs",
			)}
		>
			<span>
				© {new Date().getFullYear()} Fabric AI. All rights reserved.
			</span>
			<span className="opacity-50"> | </span>
			<LocaleLink href="/legal/privacy-policy">Privacy policy</LocaleLink>
			<span className="opacity-50"> | </span>
			<LocaleLink href="/legal/terms">Terms and conditions</LocaleLink>
		</footer>
	);
}
