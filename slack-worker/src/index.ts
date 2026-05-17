import crypto from "node:crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";

const worker = new Worker();
export default worker;

type TriageEntry = {
	source: "slack-command" | "slack-dm";
	text: string;
	teamId: string;
	reporterId: string;
	reporterName: string;
	channel: string;
	responseUrl: string | null;
	originalAuthorId: string | null;
};

function verifySlackSignature(
	rawBody: string,
	headers: Record<string, string>,
): void {
	const secret = process.env.SLACK_SIGNING_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("SLACK_SIGNING_SECRET not configured");
	}

	const timestamp = headers["x-slack-request-timestamp"];
	const signature = headers["x-slack-signature"];
	if (!timestamp || !signature?.startsWith("v0=")) {
		throw new WebhookVerificationError("Missing Slack signature headers");
	}

	const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(ageSeconds) || ageSeconds > 60 * 5) {
		throw new WebhookVerificationError("Stale Slack request timestamp");
	}

	const base = `v0:${timestamp}:${rawBody}`;
	const expected = `v0=${crypto
		.createHmac("sha256", secret)
		.update(base)
		.digest("hex")}`;

	if (
		signature.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("Invalid Slack signature");
	}
}

async function replyToSlack(responseUrl: string, text: string): Promise<void> {
	try {
		await fetch(responseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_type: "ephemeral", text }),
		});
	} catch (err) {
		console.error("[triage] failed to reply via response_url:", err);
	}
}

function parseSlashCommand(form: URLSearchParams): TriageEntry | null {
	if (form.get("command") !== "/triage") return null;
	return {
		source: "slack-command",
		text: form.get("text")?.trim() || "(no text)",
		teamId: form.get("team_id") ?? "",
		reporterId: form.get("user_id") ?? "",
		reporterName: form.get("user_name") ?? "",
		channel: form.get("channel_id") ?? "",
		responseUrl: form.get("response_url"),
		originalAuthorId: null,
	};
}

function parseMessageAction(form: URLSearchParams): TriageEntry | null {
	const payloadStr = form.get("payload");
	if (!payloadStr) return null;
	let payload: any;
	try {
		payload = JSON.parse(payloadStr);
	} catch {
		return null;
	}
	if (payload.type !== "message_action") return null;
	if (payload.callback_id !== "triage_message") return null;

	const text = (payload.message?.text ?? "").trim() || "(no text)";
	return {
		source: "slack-dm",
		text,
		teamId: payload.team?.id ?? "",
		reporterId: payload.user?.id ?? "",
		reporterName: payload.user?.username ?? payload.user?.name ?? "",
		channel: payload.channel?.id ?? "",
		responseUrl: payload.response_url ?? null,
		originalAuthorId: payload.message?.user ?? null,
	};
}

type OpportunityType =
	| "enterprise-demo"
	| "partnership"
	| "dev-user"
	| "community-buzz"
	| "unclear";

function deriveOpportunityType(text: string): OpportunityType {
	const t = text.toLowerCase();
	if (/\b(demo|enterprise|trial|evaluat|paid|pricing|premium|procure|sso|security review)\b/.test(t)) {
		return "enterprise-demo";
	}
	if (/\b(partner|integrat|api|co[- ]?market|collab|reseller)\b/.test(t)) {
		return "partnership";
	}
	if (/\b(developer|engineer|github|open[ -]?source|sdk|dev[ -]?rel|docs|tutorial)\b/.test(t)) {
		return "dev-user";
	}
	if (/\b(hiring|community|fans?|love|interest|excited|tweet|post)\b/.test(t)) {
		return "community-buzz";
	}
	return "unclear";
}

function derivePriority(text: string, type: OpportunityType): "high" | "medium" | "low" {
	const t = text.toLowerCase();
	if (/\b(urgent|asap|today|critical|escalat|deal|close|q[1-4]|fy)\b/.test(t)) return "high";
	if (type === "enterprise-demo" || type === "partnership") return "high";
	if (type === "dev-user") return "medium";
	if (type === "community-buzz") return "low";
	return "medium";
}

const SUGGESTED_OWNER: Record<OpportunityType, string> = {
	"enterprise-demo": "AE — Mid-Market",
	partnership: "Partnerships Lead",
	"dev-user": "DevRel",
	"community-buzz": "Community Manager",
	unclear: "Triage Queue",
};

const SOURCE_TO_CHANNEL: Record<string, string> = {
	"slack-command": process.env.CHANNEL_SLACK_ID ?? "",
	"slack-dm": process.env.CHANNEL_SLACK_ID ?? "",
	gmail: process.env.CHANNEL_GMAIL_ID ?? "",
	"x-brand": process.env.CHANNEL_X_ID ?? "",
	"github-star": process.env.CHANNEL_GITHUB_ID ?? "",
	"github-issue": process.env.CHANNEL_GITHUB_ID ?? "",
	"github-fork": process.env.CHANNEL_GITHUB_ID ?? "",
};

const RECOMMENDED_MOTION: Record<OpportunityType, string> = {
	"enterprise-demo": "Schedule discovery call with AE within 24h, share enterprise deck",
	partnership: "Loop in Partnerships, request co-marketing intro and joint roadmap review",
	"dev-user": "Send DevRel intro email, invite to next office hours, share advanced docs",
	"community-buzz": "Engage in thread, share roadmap teaser, capture quote for marketing",
	unclear: "Route to triage queue for human review",
};

function extractCompany(text: string): string | null {
	// Look for "@CompanyName" or "Company Name (CEO at ...)" patterns first
	const atMatch = text.match(/@([A-Z][a-zA-Z0-9_-]{2,})/);
	if (atMatch) return atMatch[1];
	// Stripe, Linear, Vercel-style: capitalized standalone word, length ≥ 3, not too generic
	const candidates = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
	const stop = new Set(["The", "This", "That", "They", "Slack", "Notion", "Triage", "DM", "API", "URL", "PM", "AM", "Hi", "Hey", "Yes", "No"]);
	for (const c of candidates) {
		if (!stop.has(c) && c.length >= 3) return c;
	}
	return null;
}

function buildTitle(type: OpportunityType, text: string, company: string | null): string {
	const subject = company ?? text.slice(0, 50);
	return `${type} – ${subject}`.slice(0, 100);
}

worker.webhook("onSlackCommand", {
	title: "Slack → Opportunities",
	description:
		"Receives /triage commands and message-action shortcuts from Slack, logs each into the Opportunities database with sales-flavored fields.",
	execute: async (events, { notion }) => {
		const databaseId = process.env.OPPORTUNITIES_DATABASE_ID;
		if (!databaseId) {
			throw new Error("OPPORTUNITIES_DATABASE_ID not configured");
		}

		for (const event of events) {
			verifySlackSignature(event.rawBody, event.headers);

			const contentType = event.headers["content-type"] ?? "";
			if (!contentType.includes("application/x-www-form-urlencoded")) {
				console.warn("[triage] unexpected content-type:", contentType);
				continue;
			}

			const form = new URLSearchParams(event.rawBody);
			const entry = parseSlashCommand(form) ?? parseMessageAction(form);
			if (!entry) {
				console.warn("[triage] unrecognized Slack payload, skipping");
				continue;
			}

			const opportunityType = deriveOpportunityType(entry.text);
			const priority = derivePriority(entry.text, opportunityType);
			const company = extractCompany(entry.text);
			const title = buildTitle(opportunityType, entry.text, company);
			const contactDisplay = entry.reporterName || "(unknown)";

			const channelId = SOURCE_TO_CHANNEL[entry.source];
			const properties: Record<string, unknown> = {
				Title: {
					title: [{ text: { content: title } }],
				},
				Source: { select: { name: entry.source } },
				"Opportunity Type": { select: { name: opportunityType } },
				Priority: { select: { name: priority } },
				Status: { select: { name: "new" } },
				Confidence: { select: { name: "medium" } },
				Company: {
					rich_text: [{ text: { content: company ?? "Unknown" } }],
				},
				"Contact Name": {
					rich_text: [{ text: { content: contactDisplay } }],
				},
				"Suggested Owner": {
					rich_text: [{ text: { content: SUGGESTED_OWNER[opportunityType] } }],
				},
				"Recommended Motion": {
					rich_text: [
						{ text: { content: RECOMMENDED_MOTION[opportunityType] } },
					],
				},
				Summary: {
					rich_text: [{ text: { content: entry.text.slice(0, 2000) } }],
				},
			};
			if (channelId) {
				properties.Channel = { relation: [{ id: channelId }] };
			}

			const page = await notion.pages.create({
				parent: { database_id: databaseId },
				properties: properties as never,
			});

			console.log(
				"[triage]",
				entry.source,
				"→",
				opportunityType,
				"(",
				priority,
				") → page:",
				page.id,
			);

			if (entry.responseUrl) {
				await replyToSlack(
					entry.responseUrl,
					`✅ Logged as ${opportunityType} (${priority}): "${title}"`,
				);
			}
		}
	},
});
