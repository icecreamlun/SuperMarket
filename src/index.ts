import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import {
	enrichGitHubActor,
	normalizeGitHubEvent,
	verifyGitHubSignature,
} from "./github";
import { writeInboundToNotion } from "./notion";
import {
	buildSignalChange,
	declareMarketSignalsDatabase,
	shouldPromote,
} from "./radar";
import { promoteSignal, queryInbox, queryRadar } from "./tools";
import { triage } from "./triage";
import {
	buildSearchPlan,
	classifySource,
	fetchTweetsForPlan,
	tweetToInboundEvent,
} from "./x";
import { processEmailReceived } from "./handler/email";

const worker = new Worker();
export default worker;

const marketSignalsDB = declareMarketSignalsDatabase(worker);

worker.webhook("onEmailReceived", {
	title: "Email Received",
	description: "Receives email events from the user's inbox, normalizes them.",
	execute: async (events, { notion }) => {
		await Promise.all(events.map((event) => processEmailReceived(event, notion)));
	},
});

worker.webhook("onGithubEvent", {
	title: "GitHub Inbound — Triage Sidekick",
	description:
		"Receives GitHub star / issues / fork events, classifies them, and writes a workspace page into the Notion intake DB.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			verifyGitHubSignature(event.rawBody, event.headers);

			const githubEvent = event.headers["x-github-event"];
			if (!githubEvent || githubEvent === "ping") {
				console.log(`Skipping non-actionable event: ${githubEvent}`);
				continue;
			}

			const inbound = normalizeGitHubEvent(
				event.deliveryId,
				githubEvent,
				event.body as Parameters<typeof normalizeGitHubEvent>[2],
			);
			if (!inbound) {
				console.log(
					`Skipping ${githubEvent} (action not actionable for inbound triage)`,
				);
				continue;
			}

			const enrichment = inbound.contact.handle
				? await enrichGitHubActor(inbound.contact.handle).catch((err) => {
					console.warn("GitHub enrichment failed:", err);
					return null;
				})
				: null;
			inbound.enrichment = enrichment ?? undefined;
			if (enrichment) {
				inbound.contact.name = enrichment.name ?? inbound.contact.name;
				inbound.contact.company =
					enrichment.company ?? inbound.contact.company;
				inbound.contact.email = enrichment.email ?? inbound.contact.email;
			}

			const result = await triage(inbound, enrichment);

			const { pageUrl } = await writeInboundToNotion(
				notion,
				inbound,
				result,
				enrichment,
			);

			console.log(
				`[${inbound.deliveryId}] ${inbound.source} → ${result.type}/${result.priority} (${result.confidence}) → ${pageUrl}`,
			);
		}
	},
});

interface XRadarState {
	lastRunAt?: string;
}

worker.sync("xMarketRadar", {
	database: marketSignalsDB,
	mode: "incremental",
	schedule: "2h",
	execute: async (state, { notion }) => {
		const previous = state as XRadarState | undefined;
		const lookbackDays = previous?.lastRunAt ? 1 : 2;
		const since = previous?.lastRunAt
			? new Date(previous.lastRunAt)
			: new Date(Date.now() - lookbackDays * 86400 * 1000);

		const plan = buildSearchPlan();
		if (plan.terms.length === 0) {
			console.warn("xMarketRadar: no search terms configured");
			return { changes: [], hasMore: false, nextState: previous };
		}

		const ownHandle = process.env.X_OWN_HANDLE;

		let tweets: Awaited<ReturnType<typeof fetchTweetsForPlan>> = [];
		try {
			tweets = await fetchTweetsForPlan(plan, since, 20);
		} catch (err) {
			console.error("xMarketRadar: Apify fetch failed:", err);
			return { changes: [], hasMore: false, nextState: previous };
		}

		const seen = new Set<string>();
		const candidates = tweets.filter((t) => {
			if (seen.has(t.id)) return false;
			seen.add(t.id);
			if (new Date(t.createdAt) < since) return false;
			const { source } = classifySource(t.text, plan);
			if (source === "x-mention" && ownHandle) {
				const self = ownHandle.replace(/^@/, "").toLowerCase();
				if (t.author.userName.toLowerCase() === self) return false;
			}
			return true;
		});

		console.log(
			`xMarketRadar: fetched ${tweets.length} tweets, ${candidates.length} candidates after filter`,
		);

		const triaged = await Promise.all(
			candidates.map(async (tweet) => {
				const { source } = classifySource(tweet.text, plan);
				const inbound = tweetToInboundEvent(tweet, source, ownHandle);
				try {
					const result = await triage(inbound, null);
					return { tweet, inbound, result };
				} catch (err) {
					console.warn(`triage failed for ${tweet.id}:`, err);
					return null;
				}
			}),
		);

		const changes: ReturnType<typeof buildSignalChange>[] = [];
		let promoted = 0;

		for (const item of triaged) {
			if (!item) continue;
			const promote = shouldPromote(item.result);
			changes.push(
				buildSignalChange(item.tweet, item.inbound, item.result, promote),
			);

			if (promote) {
				try {
					const { pageUrl } = await writeInboundToNotion(
						notion,
						item.inbound,
						item.result,
					);
					promoted += 1;
					console.log(
						`[promote] ${item.tweet.id} → ${item.result.type}/${item.result.priority} (${item.result.confidence}) → ${pageUrl}`,
					);
				} catch (err) {
					console.warn(`promotion failed for ${item.tweet.id}:`, err);
				}
			}
		}

		const processed = changes.length;

		console.log(
			`xMarketRadar: processed ${processed} tweets, promoted ${promoted} to Inbox`,
		);

		return {
			changes,
			hasMore: false,
			nextState: { lastRunAt: new Date().toISOString() } satisfies XRadarState,
		};
	},
});

const OPPORTUNITY_TYPES = [
	"partnership",
	"enterprise-demo",
	"dev-user",
	"lead-signal",
	"community-buzz",
	"competitive-intel",
	"complaint",
	"noise",
	"unclear",
] as const;

worker.tool("queryInbox", {
	title: "Query Inbox (Opportunities)",
	description:
		"List recent inbound opportunities from the Opportunities database. Use this to brief the user on what's actionable right now. Returns title, type, priority, confidence, source, suggested owner, company, summary, and recommended motion for each.",
	schema: j.object({
		type: j
			.enum(...OPPORTUNITY_TYPES)
			.describe("Filter by opportunity type")
			.nullable(),
		priority: j
			.enum("high", "medium", "low")
			.describe("Filter by priority")
			.nullable(),
		limit: j
			.number()
			.describe("Max rows to return (default 20)")
			.nullable(),
	}),
	execute: async (input, { notion }) => {
		const rows = await queryInbox(notion, {
			type: input.type ?? undefined,
			priority: input.priority ?? undefined,
			limit: input.limit ?? 20,
		});
		return JSON.parse(
			JSON.stringify({ count: rows.length, opportunities: rows }),
		);
	},
});

worker.tool("queryRadar", {
	title: "Query Market Signals (X Radar)",
	description:
		"List recent X / Twitter market signals from the Market Signals database. Use this to surface ambient public chatter about MiniMax / Anthropic / Notion dev platform. Each item has tweet content, author, follower count, type (community-buzz / lead-signal / competitive-intel / noise / …), confidence, and recommended motion.",
	schema: j.object({
		type: j
			.enum(...OPPORTUNITY_TYPES)
			.describe("Filter by signal type (e.g. lead-signal, competitive-intel, community-buzz)")
			.nullable(),
		priority: j
			.enum("high", "medium", "low")
			.describe("Filter by priority")
			.nullable(),
		minConfidence: j
			.number()
			.describe("Only return signals with confidence >= this (0-100)")
			.nullable(),
		promotedOnly: j
			.boolean()
			.describe("If true, only return signals already promoted to Inbox")
			.nullable(),
		limit: j
			.number()
			.describe("Max rows to return (default 25)")
			.nullable(),
	}),
	execute: async (input, { notion }) => {
		const rows = await queryRadar(notion, {
			type: input.type ?? undefined,
			priority: input.priority ?? undefined,
			minConfidence: input.minConfidence ?? undefined,
			promotedOnly: input.promotedOnly ?? undefined,
			limit: input.limit ?? 25,
		});
		return JSON.parse(JSON.stringify({ count: rows.length, signals: rows }));
	},
});

worker.tool("promoteSignal", {
	title: "Promote X Signal to Inbox",
	description:
		"Take a signal from the Market Signals (X Radar) database and create a full opportunity workspace in the Opportunities database. Use when the user asks to act on a specific tweet or promote a radar signal. The agent must pass the exact Tweet ID (from queryRadar results).",
	schema: j.object({
		tweetId: j
			.string()
			.describe("The Tweet ID of the signal to promote (from queryRadar)"),
	}),
	execute: async ({ tweetId }, { notion }) => {
		const result = await promoteSignal(notion, tweetId);
		return JSON.parse(JSON.stringify(result));
	},
});
