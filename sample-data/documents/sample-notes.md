# Private AI Drive Lite — Sample Notes

These notes are a tiny, license-clean sample document used to exercise the ingestion and
(later) retrieval pipeline. Import this file from the **Documents** screen to see it parsed,
chunked, and marked **Indexed**.

## What this app does

Private AI Drive Lite is an offline, local-LLM workspace that runs from a portable drive.
It keeps all user data on the device — no cloud, no telemetry, no remote APIs.

## How ingestion works

When you import a document it is copied into your workspace, its text is extracted, and the
text is split into overlapping ~500-token chunks. Each chunk remembers which section or page
it came from, so later phases can cite sources when answering questions.

## Offline by design

Nothing here needs the internet. The model runs locally, embeddings are computed locally, and
search happens locally over data stored in a single SQLite database on the drive.
