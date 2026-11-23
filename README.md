# Chrono-Rex publisher

Publishes Viking Saga posts (Instagram reels and stories, Facebook stories, Threads) at their scheduled time,
so the PC does not need to be on. Jobs are written by the PC (`video/viking-saga/tools/publish.mjs cloud ...`);
media are assets of the release `media`. GitHub Actions runs `worker.mjs` every 30 minutes.
