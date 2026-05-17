import type { InboundEvent, InboundSource, XTweet } from "./types";

const APIFY_ENDPOINT =
	"https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/run-sync-get-dataset-items";

export interface XSearchPlan {
	terms: string[];
	mentionTerm?: string;
	brandTerms: string[];
}

export function buildSearchPlan(): XSearchPlan {
	const ownHandle = process.env.X_OWN_HANDLE;
	const brandTerms =
		process.env.X_BRAND_KEYWORDS?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	const mentionTerm = ownHandle
		? `@${ownHandle.replace(/^@/, "")}`
		: undefined;

	const terms = [
		...(mentionTerm ? [mentionTerm] : []),
		...brandTerms,
	];
	return { terms, mentionTerm, brandTerms };
}

export function classifySource(
	tweetText: string,
	plan: XSearchPlan,
): { source: InboundSource; matchedQuery: string } {
	const lower = tweetText.toLowerCase();
	if (plan.mentionTerm && lower.includes(plan.mentionTerm.toLowerCase())) {
		return { source: "x-mention", matchedQuery: plan.mentionTerm };
	}
	for (const t of plan.brandTerms) {
		if (lower.includes(t.toLowerCase())) {
			return { source: "x-brand", matchedQuery: t };
		}
	}
	for (const t of plan.brandTerms) {
		const words = t.toLowerCase().split(/\s+/);
		if (words.some((w) => w.length >= 4 && lower.includes(w))) {
			return { source: "x-brand", matchedQuery: t };
		}
	}
	return {
		source: "x-brand",
		matchedQuery: plan.brandTerms[0] ?? plan.mentionTerm ?? "unknown",
	};
}

interface ApifyTweetRaw {
	type?: string;
	id?: string;
	url?: string;
	twitterUrl?: string;
	text?: string;
	fullText?: string;
	createdAt?: string;
	lang?: string;
	isReply?: boolean;
	author?: {
		userName?: string;
		name?: string;
		followers?: number;
		isBlueVerified?: boolean;
		profilePicture?: string;
		description?: string;
	};
	replyCount?: number;
	retweetCount?: number;
	likeCount?: number;
	quoteCount?: number;
	viewCount?: number;
}

async function searchTweets(
	terms: string[],
	since: Date,
	maxItems: number,
): Promise<ApifyTweetRaw[]> {
	const token = process.env.APIFY_API_TOKEN;
	if (!token) throw new Error("APIFY_API_TOKEN not configured");

	const startDate = since.toISOString().slice(0, 10);

	const res = await fetch(`${APIFY_ENDPOINT}?token=${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			searchTerms: terms,
			maxItems,
			sort: "Latest",
			start: startDate,
			includeSearchTerms: true,
		}),
	});

	if (!res.ok) {
		const detail = await res.text();
		throw new Error(`Apify call failed (${res.status}): ${detail.slice(0, 200)}`);
	}
	const data = (await res.json()) as ApifyTweetRaw[];
	return data.filter((t) => t.type === "tweet" && t.id);
}

function normalizeTweet(
	raw: ApifyTweetRaw,
	matchedQuery: string,
): XTweet | null {
	const id = raw.id;
	const text = raw.text ?? raw.fullText;
	const userName = raw.author?.userName;
	if (!id || !text || !userName) return null;

	const rawDate = raw.createdAt;
	const parsed = rawDate ? new Date(rawDate) : new Date();
	const createdAtIso = Number.isNaN(parsed.getTime())
		? new Date().toISOString()
		: parsed.toISOString();

	return {
		id,
		url: raw.url ?? raw.twitterUrl ?? `https://x.com/${userName}/status/${id}`,
		text,
		createdAt: createdAtIso,
		author: {
			userName,
			name: raw.author?.name,
			followers: raw.author?.followers,
			verified: raw.author?.isBlueVerified,
			isBlueVerified: raw.author?.isBlueVerified,
			profilePicture: raw.author?.profilePicture,
			description: raw.author?.description,
		},
		replyCount: raw.replyCount,
		retweetCount: raw.retweetCount,
		likeCount: raw.likeCount,
		quoteCount: raw.quoteCount,
		matchedQuery,
	};
}

export async function fetchTweetsForPlan(
	plan: XSearchPlan,
	since: Date,
	maxItems = 20,
): Promise<XTweet[]> {
	if (plan.terms.length === 0) return [];
	const raws = await searchTweets(plan.terms, since, maxItems);
	const tweets: XTweet[] = [];
	for (const raw of raws) {
		const text = raw.text ?? raw.fullText ?? "";
		const { matchedQuery } = classifySource(text, plan);
		const tweet = normalizeTweet(raw, matchedQuery);
		if (tweet) tweets.push(tweet);
	}
	return tweets;
}

export function tweetToInboundEvent(
	tweet: XTweet,
	source: InboundSource,
	ownHandle: string | undefined,
): InboundEvent {
	const isSelf =
		ownHandle &&
		tweet.author.userName.toLowerCase() === ownHandle.replace(/^@/, "").toLowerCase();
	const finalSource: InboundSource = isSelf ? "x-self" : source;

	return {
		deliveryId: `x-${tweet.id}`,
		source: finalSource,
		receivedAt: tweet.createdAt,
		contact: {
			handle: `@${tweet.author.userName}`,
			name: tweet.author.name,
			profileUrl: `https://x.com/${tweet.author.userName}`,
		},
		content: {
			title: tweet.text.slice(0, 80) + (tweet.text.length > 80 ? "…" : ""),
			body: tweet.text,
			url: tweet.url,
		},
		raw: tweet,
	};
}
