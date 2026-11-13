CREATE TABLE "lone_birds" (
	"day" text,
	"user_id" text,
	"at" bigint NOT NULL,
	CONSTRAINT "lone_birds_pkey" PRIMARY KEY("day","user_id")
);
--> statement-breakpoint
CREATE TABLE "voice_clips" (
	"key" text PRIMARY KEY,
	"voice" text NOT NULL,
	"text" text NOT NULL,
	"audio" bytea NOT NULL,
	"engine" text NOT NULL,
	"created_at" bigint NOT NULL
);
