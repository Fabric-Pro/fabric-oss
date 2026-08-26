import { ORPCError } from "@orpc/client";
import { addToWaitlist, isEmailOnWaitlist } from "@repo/database";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

export const waitlistSignup = publicProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/waitlist/signup",
		tags: ["Waitlist"],
		summary: "Sign up for the waitlist",
	})
	.input(
		z.object({
			email: z.string().email("Please enter a valid email address"),
			name: z.string().optional(),
			source: z.string().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
			alreadySignedUp: z.boolean(),
		}),
	)
	.handler(async ({ input }) => {
		const { email, name, source } = input;

		try {
			// Check if already on waitlist
			const alreadyExists = await isEmailOnWaitlist(email);

			// Add to waitlist (upsert handles duplicates gracefully)
			await addToWaitlist({
				email,
				name,
				source,
			});

			if (alreadyExists) {
				return {
					success: true,
					message:
						"You're already on the waitlist! We'll notify you when we launch.",
					alreadySignedUp: true,
				};
			}

			// Send notification email to admin about new waitlist signup
			try {
				await sendEmail({
					to: "hello@fabric.pro",
					subject: "New Waitlist Signup",
					html: `
						<h2>New Waitlist Signup</h2>
						<p><strong>Email:</strong> ${email}</p>
						${name ? `<p><strong>Name:</strong> ${name}</p>` : ""}
						${source ? `<p><strong>Source:</strong> ${source}</p>` : ""}
						<p><strong>Time:</strong> ${new Date().toISOString()}</p>
					`,
					text: `New waitlist signup:\nEmail: ${email}\n${name ? `Name: ${name}\n` : ""}${source ? `Source: ${source}\n` : ""}Time: ${new Date().toISOString()}`,
				});
			} catch (emailError) {
				// Log but don't fail the signup if email fails
				logger.error("Failed to send waitlist notification email", {
					error: emailError,
					email,
				});
			}

			return {
				success: true,
				message: "You're on the list! We'll notify you when we launch.",
				alreadySignedUp: false,
			};
		} catch (error) {
			logger.error("Failed to add to waitlist", { error, email });
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});
