export type InboundSource =
	| "github-star"
	| "github-issue"
	| "github-fork"
	| "slack-dm"
	| "slack-command"
	| "gmail";

export interface InboundEvent {
	deliveryId: string;
	source: InboundSource;
	receivedAt: string;
	contact: {
		handle?: string;
		name?: string;
		email?: string;
		company?: string;
		profileUrl?: string;
	};
	content: {
		title: string;
		body: string;
		url?: string;
	};
	enrichment?: GitHubEnrichment | Record<string, unknown>;
	raw: unknown;
}

export interface GitHubEnrichment {
	login: string;
	name?: string;
	company?: string;
	email?: string;
	bio?: string;
	blog?: string;
	location?: string;
	publicRepos?: number;
	followers?: number;
	topRepos?: Array<{ name: string; stars: number; language?: string }>;
	inferredTechStack: string[];
	isLikelyEnterprise: boolean;
}

export type OpportunityType =
	| "partnership"
	| "enterprise-demo"
	| "dev-user"
	| "unclear";

export type Priority = "high" | "medium" | "low";

export interface TriageResult {
	type: OpportunityType;
	devUserSubtype?:
		| "eval-signal"
		| "feature-interest"
		| "bug-feedback"
		| "deep-eval";
	priority: Priority;
	confidence: number;
	summary: string;
	whyType: string;
	whyPriority: string;
	missingInfo: string[];
	recommendedMotion: string;
	suggestedOwner: string;
	draftResponse: string;
}
