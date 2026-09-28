# Download and playback durability

## ADDED Requirements

### Requirement: Player queue survives worker restarts
The service worker SHALL persist the play queue and its index from every
playback entry point, and SHALL NOT produce duplicate scrobbles after a restart.

#### Scenario: Restart keeps the queue position
- **WHEN** the worker restarts mid-queue
- **THEN** the queue and the current index are restored, and the played track
  is scrobbled exactly once.

### Requirement: Downloads batch their journal writes and survive segment failures
The downloader SHALL persist a bulk enqueue in a single journal write, SHALL
retry failed HLS segments, and SHALL hand large tracks to the downloads API
without holding two full copies in worker memory.

#### Scenario: Flaky segment does not kill the track
- **WHEN** one HLS segment fails transiently
- **THEN** the segment is retried and the track completes.
