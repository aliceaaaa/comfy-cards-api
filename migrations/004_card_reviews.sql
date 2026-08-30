CREATE TABLE card_reviews (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  box integer NOT NULL DEFAULT 0,
  interval_days integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz,
  correct_count integer NOT NULL DEFAULT 0,
  wrong_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX card_reviews_due_idx ON card_reviews (user_id, due_at);
