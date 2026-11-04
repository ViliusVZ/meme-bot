-- Roast lines rotate through one shared bag per family (solo, duo, trio, memes) holding the
-- lines themselves. The old per-person bags held line indices: start every cycle fresh.
DELETE FROM "roast_bags";--> statement-breakpoint
ALTER TABLE "roast_bags" DROP COLUMN "last";--> statement-breakpoint
ALTER TABLE "roast_bags" ADD COLUMN "last_line" text;