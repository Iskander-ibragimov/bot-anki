-- Voice is played only when the user taps the speaker button. Automatic playback stays an option in /settings,
-- but it is switched off for everyone who had it on: the owner asked for sound on demand only.
UPDATE users SET autoplay = 0 WHERE autoplay != 0;
