CREATE TABLE "news_cache" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_stories" (
	"id" text PRIMARY KEY,
	"source" text NOT NULL,
	"sub" text NOT NULL,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL,
	"top_rank" integer,
	"best_rank" integer,
	"hot_rank" integer,
	"prev_hot_rank" integer,
	"prev_at" bigint,
	"state" text NOT NULL,
	"reason" text,
	"verdict" jsonb,
	"score" integer,
	"same_as" text,
	"official" text,
	"comments" integer,
	"writeup" jsonb,
	"write_tries" integer DEFAULT 0 NOT NULL,
	"write_first" bigint,
	"message_id" text,
	"posted_at" bigint
);
