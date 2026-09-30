ALTER TABLE users ADD COLUMN next_daily_at INTEGER;
ALTER TABLE users ADD COLUMN next_evening_at INTEGER;
CREATE INDEX idx_users_next_daily ON users(next_daily_at);
CREATE INDEX idx_users_next_evening ON users(next_evening_at);
CREATE INDEX idx_users_last_review ON users(last_review_at);
UPDATE users SET next_daily_at = 0, next_evening_at = 0 WHERE onboarding_step IS NULL;
DROP INDEX IF EXISTS idx_users_active_remind;
