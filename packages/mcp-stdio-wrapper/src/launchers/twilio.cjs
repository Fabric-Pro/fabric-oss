"use strict";
// Twilio's server reads credentials only from argv; move them there inside this process.
const [, , binPath, ...rest] = process.argv;
const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET } = process.env;
if (!binPath || !TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
	console.error("Twilio launcher: missing package path or credentials");
	process.exit(1);
}
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_API_KEY;
delete process.env.TWILIO_API_SECRET;
process.argv = [
	process.argv[0],
	binPath,
	...rest,
	`--accountSid=${TWILIO_ACCOUNT_SID}`,
	`--apiKey=${TWILIO_API_KEY}`,
	`--apiSecret=${TWILIO_API_SECRET}`,
];
require(binPath);
