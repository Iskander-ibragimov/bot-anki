ALTER TABLE users ADD COLUMN new_order TEXT NOT NULL DEFAULT 'deck' CHECK (new_order IN ('deck','random'));

-- A user's own picture and link for a word. Per user, so attaching media to a shared catalog word never shows it to others.
CREATE TABLE user_note_media (
  user_id INTEGER NOT NULL REFERENCES users(id),
  note_id INTEGER NOT NULL REFERENCES notes(id),
  image_file_id TEXT,
  source_url TEXT,
  PRIMARY KEY (user_id, note_id)
);
