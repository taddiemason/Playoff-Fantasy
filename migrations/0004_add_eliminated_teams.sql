CREATE TABLE IF NOT EXISTS eliminated_teams (
  abbrev TEXT NOT NULL,
  season TEXT NOT NULL,
  PRIMARY KEY (abbrev, season)
);
