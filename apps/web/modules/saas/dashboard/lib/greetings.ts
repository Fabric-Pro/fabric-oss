const GREETINGS = [
	"Hello, {firstName}! 👋",
	"Hey, {firstName}! 🙋",
	"Good to see you, {firstName}! 😊",
	"What's up, {firstName}? 🙌",
	"How's it going, {firstName}? 🚀",
	"Hiya, {firstName}! 🌟",
	"Yo, {firstName}! 😎",
	"Welcome, {firstName}! 🎉",
	"Howdy, {firstName}! 🤠",
	"Greetings, {firstName}! 🌈",
	"Salutations, {firstName}! 🎩",
	"What's new, {firstName}? 💌",
	"How are you, {firstName}? 🤗",
	"Ahoy, {firstName}! ⚓",
	"Bonjour, {firstName}! 🥖",
	"Hola, {firstName}! 🌮",
	"Ciao, {firstName}! 🍕",
	"Namaste, {firstName}! 🪷",
	"Konnichiwa, {firstName}! 🎌",
	"Aloha, {firstName}! 🌺",
	"Hey there, {firstName}! 💡",
	"Good day, {firstName}! 🌞",
	"Welcome back, {firstName}! 🔄",
	"Long time no see, {firstName}! ⏰",
	"Great to meet you, {firstName}! 🤝",
	"Pleased to see you, {firstName}! 😁",
	"Cheers, {firstName}! 🥂",
	"Happy to chat, {firstName}! 💬",
	"What's happening, {firstName}? 🎈",
	"Missed you, {firstName}! 💛",
	"Glad you're here, {firstName}! 📍",
	"Smile, {firstName}! 😄",
	"Lookin' good, {firstName}! 👍",
	"What's cooking, {firstName}? 🍳",
	"Stay cool, {firstName}! ❄️",
	"Keep shining, {firstName}! 💎",
	"You're a star, {firstName}! ⭐",
	"Rise and shine, {firstName}! 🌅",
	"Keep it up, {firstName}! 💪",
	"Rock on, {firstName}! 🤘",
] as const;

export const DASHBOARD_GREETING_COUNT = GREETINGS.length;

export function getDashboardGreeting(
	name: string | null | undefined,
	index: number,
): string {
	const firstName = name?.trim().split(/\s+/)[0] || "there";
	const template = GREETINGS[index % GREETINGS.length];
	return template.replace("{firstName}", firstName);
}
