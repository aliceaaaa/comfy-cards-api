ALTER TABLE decks
  ADD COLUMN description text,
  ADD COLUMN language text,
  ADD COLUMN topic text,
  ADD COLUMN slug text UNIQUE,
  ADD COLUMN is_public boolean NOT NULL DEFAULT false;

CREATE INDEX decks_public_idx ON decks (language, title) WHERE is_public;
