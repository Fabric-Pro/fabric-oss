import { LocaleLink } from "@i18n/routing";
import { config } from "@repo/config";
import { Logo } from "@shared/components/Logo";

export function Footer() {
	return (
		<footer className="border-t py-8 text-foreground/60 text-sm">
			<div className="container grid grid-cols-1 gap-6 lg:grid-cols-3">
				<div>
					<Logo className="opacity-70 grayscale" />
					<p className="mt-3 text-sm opacity-70">
						© {new Date().getFullYear()} {config.appName}. All
						rights reserved.
					</p>
					<p className="mt-2 text-xs opacity-60">
						Fabric is a product of{" "}
						<a
							href="https://techfabric.com"
							className="font-medium text-primary hover:underline"
						>
							TechFabric
						</a>
						, empowering teams with governed AI automation.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<LocaleLink href="/blog" className="block">
						Blog
					</LocaleLink>

					<LocaleLink href="/#agents" className="block">
						Agents
					</LocaleLink>

					<LocaleLink href="/#compare" className="block">
						Compare
					</LocaleLink>
				</div>

				<div className="flex flex-col gap-2">
					<a
						href="https://techfabric.com/contact"
						data-fabric-placement="footer"
						className="block"
					>
						Contact TechFabric
					</a>

					<LocaleLink href="/legal/privacy-policy" className="block">
						Privacy policy
					</LocaleLink>

					<LocaleLink href="/legal/terms" className="block">
						Terms and conditions
					</LocaleLink>
				</div>
			</div>
		</footer>
	);
}
