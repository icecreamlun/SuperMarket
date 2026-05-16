import crypto from "node:crypto";
import { WebhookVerificationError } from "@notionhq/workers";
import type { GitHubEnrichment, InboundEvent, InboundSource } from "./types";

export function verifyGitHubSignature(
	rawBody: string,
	headers: Record<string, string>,
): void {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) {
		throw new WebhookVerificationError(
			"GITHUB_WEBHOOK_SECRET not configured",
		);
	}

	const signature = headers["x-hub-signature-256"];
	if (!signature?.startsWith("sha256=")) {
		throw new WebhookVerificationError("Missing GitHub signature header");
	}

	const expected = `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;

	if (signature.length !== expected.length) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}
	if (
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}
}

interface GitHubBody {
	action?: string;
	sender?: { login: string; html_url?: string; type?: string };
	repository?: { full_name: string; html_url: string };
	issue?: { number: number; title: string; body?: string; html_url: string };
	starred_at?: string;
	forkee?: { full_name: string; html_url: string };
}

export function normalizeGitHubEvent(
	deliveryId: string,
	githubEvent: string,
	body: GitHubBody,
): InboundEvent | null {
	const sender = body.sender;
	const repo = body.repository;
	if (!sender || !repo) return null;

	let source: InboundSource;
	let title: string;
	let bodyText: string;
	let url = repo.html_url;

	switch (githubEvent) {
		case "star":
			if (body.action !== "created") return null;
			source = "github-star";
			title = `${sender.login} starred ${repo.full_name}`;
			bodyText = `GitHub user @${sender.login} starred the repository ${repo.full_name}.`;
			break;
		case "issues":
			if (body.action !== "opened" || !body.issue) return null;
			source = "github-issue";
			title = body.issue.title;
			bodyText = body.issue.body ?? "";
			url = body.issue.html_url;
			break;
		case "fork":
			source = "github-fork";
			title = `${sender.login} forked ${repo.full_name}`;
			bodyText =
				`GitHub user @${sender.login} forked ${repo.full_name}` +
				(body.forkee ? ` to ${body.forkee.full_name}` : "");
			url = body.forkee?.html_url ?? repo.html_url;
			break;
		default:
			return null;
	}

	return {
		deliveryId,
		source,
		receivedAt: new Date().toISOString(),
		contact: {
			handle: sender.login,
			profileUrl: sender.html_url,
		},
		content: { title, body: bodyText, url },
		raw: body,
	};
}

const ENTERPRISE_EMAIL_DOMAINS_BLOCKLIST = new Set([
	"gmail.com",
	"yahoo.com",
	"hotmail.com",
	"outlook.com",
	"icloud.com",
	"protonmail.com",
	"qq.com",
	"163.com",
]);

export async function enrichGitHubActor(
	login: string,
): Promise<GitHubEnrichment | null> {
	const token = process.env.GITHUB_TOKEN;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "triage-sidekick",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const userRes = await fetch(`https://api.github.com/users/${login}`, {
		headers,
	});
	if (!userRes.ok) return null;
	const user = (await userRes.json()) as {
		login: string;
		name?: string;
		company?: string;
		email?: string;
		bio?: string;
		blog?: string;
		location?: string;
		public_repos?: number;
		followers?: number;
	};

	const reposRes = await fetch(
		`https://api.github.com/users/${login}/repos?sort=updated&per_page=20`,
		{ headers },
	);
	const repos = reposRes.ok
		? ((await reposRes.json()) as Array<{
				name: string;
				stargazers_count: number;
				language?: string;
				fork: boolean;
			}>)
		: [];

	const topRepos = repos
		.filter((r) => !r.fork)
		.sort((a, b) => b.stargazers_count - a.stargazers_count)
		.slice(0, 5)
		.map((r) => ({
			name: r.name,
			stars: r.stargazers_count,
			language: r.language,
		}));

	const inferredTechStack = Array.from(
		new Set(repos.map((r) => r.language).filter((x): x is string => !!x)),
	).slice(0, 8);

	const emailDomain = user.email?.split("@")[1]?.toLowerCase();
	const isLikelyEnterprise =
		!!user.company ||
		(!!emailDomain && !ENTERPRISE_EMAIL_DOMAINS_BLOCKLIST.has(emailDomain));

	return {
		login: user.login,
		name: user.name,
		company: user.company,
		email: user.email,
		bio: user.bio,
		blog: user.blog,
		location: user.location,
		publicRepos: user.public_repos,
		followers: user.followers,
		topRepos,
		inferredTechStack,
		isLikelyEnterprise,
	};
}
