ALTER TABLE "game_nights" ADD COLUMN "maybes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_nights" ADD COLUMN "paused_until" bigint;