CREATE TABLE "news_items" (
	"topic_id" integer PRIMARY KEY,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"section" text,
	"published_at" bigint NOT NULL,
	"seen_at" bigint NOT NULL,
	"state" text NOT NULL,
	"summary" text,
	"last_post" integer DEFAULT 0 NOT NULL,
	"told_post" integer DEFAULT 0 NOT NULL,
	"message_id" text,
	"posted_at" bigint,
	"updated_day" text
);
