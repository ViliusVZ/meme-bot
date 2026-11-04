-- The starter game list (games people add later come after these, in the order they're added)
INSERT INTO "games" ("name", "emoji", "added_at") VALUES
  ('World of Warcraft', '⚔️', '2026-11-03'),
  ('R.E.P.O.', '📦', '2026-11-03'),
  ('Phasmophobia', '👻', '2026-11-03'),
  ('Demonologist', '😈', '2026-11-03'),
  ('Palworld', '🐑', '2026-11-03'),
  ('Enshrouded', '🌫️', '2026-11-03'),
  ('RuneScape: Dragonwilds', '🐉', '2026-11-03'),
  ('Counter-Strike 2', '🔫', '2026-11-03')
ON CONFLICT DO NOTHING;
