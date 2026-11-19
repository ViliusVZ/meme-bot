CREATE TABLE "joke_votes" (
	"joke_id" integer,
	"user_id" text,
	"kind" text NOT NULL,
	"voted_at" text NOT NULL,
	CONSTRAINT "joke_votes_pkey" PRIMARY KEY("joke_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "jokes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jokes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"text" text NOT NULL,
	"norm" text NOT NULL,
	"lang" text NOT NULL,
	"theme" text NOT NULL,
	"form" text NOT NULL,
	"added_at" text NOT NULL,
	"day" text,
	"posted_at" text,
	"channel_id" text,
	"message_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jokes_norm" ON "jokes" ("norm");--> statement-breakpoint
CREATE UNIQUE INDEX "one_joke_per_day" ON "jokes" ("day");--> statement-breakpoint
CREATE INDEX "jokes_stock" ON "jokes" ("added_at") WHERE "day" IS NULL;--> statement-breakpoint
ALTER TABLE "joke_votes" ADD CONSTRAINT "joke_votes_joke_id_jokes_id_fkey" FOREIGN KEY ("joke_id") REFERENCES "jokes"("id");