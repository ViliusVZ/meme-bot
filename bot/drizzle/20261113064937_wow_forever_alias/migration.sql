-- ⚔️ What Discord calls the trio's game (plan 07): "World of Warcraft: Forever" is World of Warcraft.
-- A fact, not a guess, so it isn't left to Gemini. Only on a database that has planned a night
-- (production, the test bot): a fresh one starts with no aliases, as every test's schema does.
INSERT INTO "game_aliases" ("activity", "game", "added_by")
SELECT 'World of Warcraft: Forever', "name", 'plan 07' FROM "games"
WHERE "name" = 'World of Warcraft' AND EXISTS (SELECT 1 FROM "game_nights")
ON CONFLICT ("activity") DO NOTHING;
