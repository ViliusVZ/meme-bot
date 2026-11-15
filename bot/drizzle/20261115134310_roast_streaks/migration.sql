CREATE TABLE "chases" (
	"day" text,
	"user_id" text,
	"at" bigint NOT NULL,
	CONSTRAINT "chases_pkey" PRIMARY KEY("day","user_id")
);
--> statement-breakpoint
CREATE TABLE "streak_breaks" (
	"user_id" text,
	"broken_on" text,
	"card_day" text NOT NULL,
	"streak" integer NOT NULL,
	"line" text NOT NULL,
	CONSTRAINT "streak_breaks_pkey" PRIMARY KEY("user_id","broken_on")
);
--> statement-breakpoint
CREATE INDEX "streak_breaks_card" ON "streak_breaks" ("card_day");