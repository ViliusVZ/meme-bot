CREATE TABLE "panels" (
	"message_id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"tapped_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "panels_day" ON "panels" USING btree ("day");