import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { auth } from "../auth";

async function main() {
	const rl = readline.createInterface({ input, output });

	try {
		logger.info("\nCreate an account and verify\n");
		const email = await rl.question("Email: ");
		if (!email) {
			throw new Error("Email is required");
		}

		const password = await rl.question("Password: ");
		if (!password) {
			throw new Error("Password is required");
		}

		const existingUser = await db.user.findUnique({ where: { email } });
		if (existingUser) {
			logger.info(
				`User ${email} already exists. Updating to verified...`,
			);
			await db.user.update({
				where: { email },
				data: { emailVerified: true, onboardingComplete: true },
			});
			logger.success("User verified successfully!");
			return;
		}

		logger.info("Hashing password and creating user...");
		const authContext = await auth.$context;
		const hashedPassword = await authContext.password.hash(password);
		const now = new Date();

		await db.$transaction(async (tx) => {
			const created = await tx.user.create({
				data: {
					email,
					name: email.split("@")[0],
					role: "admin",
					emailVerified: true,
					onboardingComplete: true,
					createdAt: now,
					updatedAt: now,
				},
			});

			await tx.account.create({
				data: {
					userId: created.id,
					accountId: created.id,
					providerId: "credential",
					password: hashedPassword,
					createdAt: now,
					updatedAt: now,
				},
			});
		});

		logger.success(`\nSuccessfully created and verified user: ${email}`);
	} catch (error) {
		logger.error("\nFailed to create user:", error);
	} finally {
		rl.close();
		process.exit(0);
	}
}

main();
