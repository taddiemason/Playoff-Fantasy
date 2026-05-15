ALTER TABLE team_players ADD COLUMN crest_url TEXT DEFAULT '';

UPDATE team_players
SET crest_url = 'https://assets.nhle.com/logos/nhl/svg/' || UPPER(nhl_team) || '_light.svg'
WHERE nhl_team != '';
