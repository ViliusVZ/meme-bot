CREATE TABLE "roast_bags" (
	"pool" text PRIMARY KEY NOT NULL,
	"queue" jsonb NOT NULL,
	"last" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_nights" ADD COLUMN "warned" text;--> statement-breakpoint
ALTER TABLE "game_nights" ADD COLUMN "roast" jsonb;--> statement-breakpoint
ALTER TABLE "game_nights" ADD COLUMN "roast_due" bigint;--> statement-breakpoint
ALTER TABLE "game_nights" ADD COLUMN "roasted_at" bigint;