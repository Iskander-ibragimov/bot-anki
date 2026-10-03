-- The album (media group) whose first photo was already handled: the other photos of the same album are not separate cards.
ALTER TABLE users ADD COLUMN last_media_group TEXT;
