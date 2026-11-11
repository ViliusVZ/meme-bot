CREATE TABLE "activity_guesses" (
	"activity" "citext" PRIMARY KEY NOT NULL,
	"game" "citext",
	"answered" boolean DEFAULT false NOT NULL,
	"at" bigint NOT NULL
);
