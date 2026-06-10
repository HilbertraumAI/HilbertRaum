# CLAUDE.md — Private AI Drive Lite MVP

_Last updated: 2026-06-09_

This file is the working instruction document for building the **Private AI Drive Lite** MVP with Claude Code. It is intentionally detailed so that implementation context is preserved across coding sessions.

The project goal is to create an open-source local/offline AI application that can be installed on a user-owned USB-C SSD / NVMe drive and launched on a normal laptop. The commercial product will be a preconfigured drive sold to non-technical users, while advanced users can clone the GitHub repository and prepare their own drive.

---

## 0. Claude Code operating instructions

### 0.1 How Claude Code should use this file

Treat this file as the source of truth for the MVP unless the human explicitly overrides it.

When implementing:

1. Read this file first.
2. Preserve the architecture and product assumptions unless a change is explicitly requested.
3. Prefer small, incremental changes with tests.
4. Do not add cloud dependencies.
5. Do not introduce telemetry, analytics, external APIs, or hosted services.
6. Keep the application usable when the computer has no internet connection.
7. Keep all user data local by default.
8. Keep model binaries and model weights out of git.
9. Store large model files on the external drive under `/models`.
10. Design every feature so that it works for non-technical users.

### 0.2 Claude Code development rules

Use this workflow:

```bash
# inspect
ls
find . -maxdepth 3 -type f | sort

# install dependencies
# use the package manager already present in the repo; do not switch package managers casually

# implement one vertical slice at a time
# run tests after each meaningful change
# update docs after architecture changes
```

Claude Code must not:

- secretly call cloud LLM APIs
- add OpenAI, Anthropic, Google, Mistral, or other hosted AI API dependencies
- upload prompts, documents, embeddings, logs, crash reports, or telemetry
- hardcode developer-specific absolute paths
- assume the drive path is the same across operating systems
- commit model weights, user data, embeddings, logs, or generated files
- store user documents in plaintext unless the user explicitly chooses an unencrypted workspace
- present the external drive as “RAM expansion” or a magical performance booster

Claude Code should:

- use local binaries and local files
- provide clear error messages
- prefer portable, boring technology
- make the first-run experience simple
- treat Windows support as a first-class requirement
- make macOS and Linux support part of the architecture from the start
- write integration tests around the local API boundary
- keep backend boundaries clean so runtimes can be swapped later

---

## 1. Product definition

### 1.1 Product name

Working name: **Private AI Drive Lite**

Alternative names under consideration:

- Private AI Drive
- Sovereign AI Drive
- Offline AI Drive
- LocalGPT Drive
- AI Vault Lite

For MVP code and directories, use:

```text
private-ai-drive-lite
```

### 1.2 Product thesis

Private AI Drive Lite is an open-source offline AI workspace for normal laptop users.

The user plugs in an external USB-C SSD, launches the app, and gets:

- private offline chat
- local document Q&A
- basic summarization
- email/document drafting
- translation and rewriting
- simple reasoning over local files
- no cloud dependency
- no telemetry
- local model execution

### 1.3 Commercial model

There are two distribution paths:

#### A. Open-source DIY toolkit

For technical users:

- clone GitHub repository
- run setup script
- prepare their own USB-C SSD
- download supported local models
- run the app locally

#### B. Preconfigured drive

For normal users:

- buy a prepared SSD from our shop
- plug it into laptop
- launch the app
- use preinstalled local models
- optionally update models via signed update bundles

The preconfigured commercial product monetizes:

- curation
- packaging
- tested hardware
- signed installers
- support
- documentation
- compliance-focused UX
- preloaded model packs
- polished onboarding

The software core should remain open source.

### 1.4 MVP target user

The MVP should target a normal European laptop user who:

- is privacy-conscious
- has confidential documents
- does not want to send prompts or documents to cloud LLMs
- is not comfortable using GitHub, Python, Docker, Ollama, llama.cpp, or terminal commands
- uses Windows or macOS
- has 8–16 GB RAM
- may have no dedicated GPU

The MVP should also support advanced users who run it from source.

### 1.5 MVP success definition

The MVP is successful when a non-technical user can:

1. Plug in the drive.
2. Launch the app.
3. Confirm offline mode.
4. Start a local chat.
5. Add a small folder of documents.
6. Ask a question about those documents.
7. Receive an answer with source citations.
8. Close the app.
9. Unplug the drive.
10. Move the drive to another supported laptop and continue using the same workspace.

---

## 2. Scope

### 2.1 Private AI Drive Lite MVP includes

Core features:

- cross-platform desktop app
- local-only chat with a small/medium open-weight model
- local model manager using model manifest files
- local llama.cpp sidecar runtime
- first-run hardware benchmark
- automatic model recommendation
- offline mode indicator
- local document import
- local document chunking
- local embeddings
- local vector search
- retrieval-augmented generation
- source citations
- encrypted workspace option
- local chat history
- basic settings screen
- logs for debugging, stored locally
- clear “no cloud” privacy explanation
- packaged developer setup scripts

### 2.2 MVP explicitly excludes

Do not implement in Lite MVP:

- image generation
- Stable Diffusion
- ComfyUI
- agentic browser control
- email/calendar integrations
- cloud fallback
- team collaboration
- multi-user accounts
- enterprise admin console
- fine-tuning
- model training
- local voice input/output
- mobile apps
- web hosting
- GPU-specific tuning UI
- paid licensing logic
- hardware dongle DRM
- full GDPR compliance automation
- legal/medical advice claims

These can be planned later but should not distract the MVP.

---

## 3. Technical positioning and constraints

### 3.1 External drive role

The external drive is not RAM.

The drive helps by providing:

- portable storage for models
- portable encrypted user workspace
- fast model loading when using a good NVMe SSD
- space for document indexes and embeddings
- consistent preconfigured layout
- offline update medium
- customer-owned data boundary

The drive does **not** solve:

- insufficient system RAM
- insufficient VRAM
- slow CPU
- thermal throttling
- poor model quality
- all hallucination risks

The app must be honest about hardware limits.

### 3.2 Runtime strategy

Use local inference only.

Default runtime:

- `llama.cpp`
- model format: `GGUF`
- runtime binary launched as a sidecar process
- app communicates with local runtime over localhost HTTP or stdio

The architecture should allow later support for:

- Ollama-compatible backend
- MLX backend for Apple Silicon
- ONNX Runtime backend
- Vulkan/Metal/CUDA-specific builds
- remote enterprise on-prem backend, but not in MVP

### 3.3 Model strategy

Default model family for MVP:

- Qwen3 dense instruct models, because they offer a useful size ladder and permissive Apache 2.0 licensing for many variants.
- Use quantized GGUF files.
- Do not commit model files into git.

Target models for Lite:

| Model role | Initial candidate | Purpose |
|---|---|---|
| Chat small | Qwen3 1.7B Instruct GGUF Q4 | Works on weak laptops |
| Chat balanced | Qwen3 4B Instruct GGUF Q4 | Main Lite model |
| Chat better | Qwen3 8B Instruct GGUF Q4 | Optional for 16 GB+ RAM |
| Embeddings | small multilingual embedding model | Local document search |
| Reranker | optional, not required for v0.1 | Better citations later |

> **Deviations from this spec as built (2026-06-10, see [`BUILD_STATE.md`](BUILD_STATE.md) §9):**
> The **Qwen3 1.7B** "chat small" model was **dropped** — the official `Qwen/Qwen3-1.7B-GGUF` repo
> publishes no Q4_K_M build. **Qwen3 4B** (the smallest bundled chat model) now also covers the TINY
> and UNKNOWN hardware tiers (overriding the §7.3 table rows below that map them to 1.7B). The
> embeddings model is shipped as **F16**, not Q8 — q8_0 GGUFs of this BERT/XLM-R model fail to load on
> the pinned llama.cpp (b9585). This note is the source of truth where it conflicts with the tables.

The app must support model manifests so models can be changed without code changes.

Example manifest:

```yaml
id: qwen3-4b-instruct-q4
display_name: Qwen3 4B Instruct Q4
family: qwen3
role: chat
format: gguf
runtime: llama_cpp
license: apache-2.0
size_on_disk_gb: 2.7
recommended_min_ram_gb: 8
recommended_ram_gb: 16
recommended_context_tokens: 4096
supports_thinking_mode: true
supports_tools: false
local_path: models/chat/qwen3-4b-instruct-q4.gguf
sha256: REPLACE_WITH_REAL_HASH
download_url: null
bundled_on_preconfigured_drive: true
```

### 3.4 Document intelligence strategy

The MVP should support:

- `.txt`
- `.md`
- `.pdf` text extraction
- `.docx`
- `.csv`
- optionally `.xlsx` later

Minimum RAG pipeline:

1. User imports file or folder.
2. App copies file into encrypted workspace or references it based on setting.
3. Text extractor extracts readable text.
4. Text is chunked.
5. Embeddings are generated locally.
6. Chunks and embeddings are stored in a local vector store.
7. User asks a question.
8. App retrieves relevant chunks.
9. App sends a grounded prompt to local LLM.
10. LLM answers with citations.
11. UI displays cited source snippets and file references.

Citation format in UI:

```text
Answer paragraph. [Source: Contract.pdf, p. 4]
```

### 3.5 Security baseline

The MVP must be designed around local privacy.

Default principles:

- No cloud calls.
- No telemetry.
- No analytics.
- No remote crash reporting.
- No prompt upload.
- No document upload.
- No embedding upload.
- No automatic model downloads unless user explicitly opts in.
- No plaintext workspace unless user explicitly chooses it.

Encryption plan:

- MVP v0.1 may support unencrypted developer mode for speed.
- MVP v0.2 should add encrypted workspace.
- MVP commercial beta should default to encrypted workspace.

Recommended encryption design:

- user chooses workspace password
- derive key with Argon2id
- encrypt workspace database and document cache
- never store password
- store salt and KDF parameters
- lock workspace on app close
- optional “remember on this computer” later using OS keychain

Data to protect:

- imported documents
- extracted text
- embeddings
- chat history
- generated outputs
- audit/debug logs
- model usage metadata if sensitive

### 3.6 Offline mode

The app needs a visible status indicator:

- **Offline Mode: ON**
- **Network access disabled by policy**
- **No prompts or files leave this device**

Implementation options:

- MVP: do not make network calls by design
- Later: add optional OS-level firewall helper or app-level network denylist
- Later enterprise: signed policy file that disables model downloads and updates

Settings should include:

```text
[ ] Allow internet access for model downloads and updates
```

Default: unchecked.

---

## 4. Recommended technology stack

### 4.1 Desktop app

Preferred:

- Tauri
- TypeScript frontend
- React or Svelte frontend
- Rust backend commands

Rationale:

- smaller bundle than Electron
- good native integration
- Rust is suitable for file I/O, process management, encryption
- easier to ship desktop apps
- no need for a local browser server exposed to the network

Alternative:

- Electron + TypeScript

Use Electron only if Tauri blocks important capabilities.

### 4.2 Backend

Primary backend responsibilities:

- launch local model runtime
- manage workspace
- manage files
- run ingestion
- run benchmark
- expose app commands to UI
- store settings
- manage model manifests
- manage logs

Implementation:

- Rust backend inside Tauri
- sidecar binaries for llama.cpp
- optional helper processes for embeddings

### 4.3 Inference

Use `llama.cpp` sidecar.

Possible modes:

1. `llama-server` local HTTP server on `127.0.0.1`
2. direct CLI invocation for simple prompts
3. linked library later

MVP recommendation:

- Use `llama-server` sidecar for chat.
- Bind to `127.0.0.1` only.
- Randomize or manage local port.
- Shut down when app exits.
- Do not expose to LAN.

### 4.4 Storage

Recommended local storage components:

| Data | Storage |
|---|---|
| settings | JSON/TOML file |
| model manifests | YAML/JSON |
| chat history | SQLite |
| document metadata | SQLite |
| chunks | SQLite |
| embeddings/vector index | SQLite extension or local vector DB |
| logs | rotating local text logs |
| encrypted workspace | encrypted database/files |

Vector store options:

1. `sqlite-vec` or similar SQLite vector extension
2. LanceDB local
3. HNSW index with metadata in SQLite

MVP preference:

- Use SQLite for metadata.
- For vector search, choose the simplest reliable local option available for Rust/Node integration.
- Avoid requiring Docker, Postgres, Qdrant server, or cloud services.

### 4.5 Document parsing

Implement adapters:

```text
DocumentParser
├── TxtParser
├── MarkdownParser
├── PdfParser
├── DocxParser
└── CsvParser
```

MVP libraries can be selected during implementation, but constraints are:

- must run locally
- must not require cloud OCR
- must handle bad files gracefully
- must record extraction errors
- must preserve source filename and page/section metadata when possible

Scanned PDFs:

- not required in v0.1
- later: local OCR via Tesseract or similar

### 4.6 Embeddings

Embedding requirements:

- local only
- deterministic
- multilingual preferred
- CPU-friendly
- cache embeddings
- store model ID with each embedding
- re-index when embedding model changes

Potential implementation options:

- call local embedding model via llama.cpp if supported
- use ONNX Runtime with a small sentence-transformer-style model
- use a lightweight Rust/Node embedding library if stable

For v0.1, prioritize correctness over best retrieval quality.

### 4.7 Build system

Expected repo tools:

- Node.js package manager: `pnpm` preferred
- Rust toolchain
- Tauri CLI
- platform-specific sidecar binaries
- scripts for setup and model verification

Do not require Docker for the normal app.

Docker may be used for CI or developer utilities only.

---

## 5. Repository structure

Target structure:

```text
private-ai-drive-lite/
├── CLAUDE.md
├── README.md
├── LICENSE
├── SECURITY.md
├── PRIVACY.md
├── CONTRIBUTING.md
├── package.json
├── pnpm-lock.yaml
├── apps/
│   └── desktop/
│       ├── package.json
│       ├── src/
│       │   ├── main.tsx
│       │   ├── app/
│       │   ├── components/
│       │   ├── screens/
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── styles/
│       ├── src-tauri/
│       │   ├── Cargo.toml
│       │   ├── tauri.conf.json
│       │   ├── build.rs
│       │   ├── capabilities/
│       │   ├── sidecars/
│       │   └── src/
│       │       ├── main.rs
│       │       ├── commands/
│       │       ├── runtime/
│       │       ├── models/
│       │       ├── workspace/
│       │       ├── ingestion/
│       │       ├── rag/
│       │       ├── security/
│       │       ├── benchmark/
│       │       └── logging/
│       └── tests/
├── crates/
│   ├── paid-core/
│   ├── paid-rag/
│   ├── paid-security/
│   └── paid-benchmark/
├── model-manifests/
│   ├── chat/
│   ├── embeddings/
│   └── README.md
├── scripts/
│   ├── setup-dev.sh
│   ├── setup-dev.ps1
│   ├── prepare-drive.sh
│   ├── prepare-drive.ps1
│   ├── verify-models.sh
│   └── verify-models.ps1
├── docs/
│   ├── architecture.md
│   ├── mvp-roadmap.md
│   ├── drive-layout.md
│   ├── model-policy.md
│   ├── security-model.md
│   ├── rag-design.md
│   ├── benchmark-plan.md
│   └── packaging.md
├── sample-data/
│   ├── documents/
│   └── README.md
└── tests/
    ├── fixtures/
    └── integration/
```

If this is too much for the first commit, start with:

```text
private-ai-drive-lite/
├── CLAUDE.md
├── README.md
├── apps/desktop
├── model-manifests
├── scripts
└── docs
```

Then expand.

---

## 6. External drive layout

The prepared drive should have a clear layout.

```text
PRIVATE_AI_DRIVE/
├── Start Private AI Drive.exe
├── Start Private AI Drive.app
├── start-private-ai-drive.sh
├── app/
│   ├── windows/
│   ├── macos/
│   └── linux/
├── runtime/
│   ├── llama.cpp/
│   │   ├── windows/
│   │   ├── macos/
│   │   └── linux/
│   └── embeddings/
├── models/
│   ├── chat/
│   │   ├── qwen3-1.7b-instruct-q4.gguf
│   │   ├── qwen3-4b-instruct-q4.gguf
│   │   └── qwen3-8b-instruct-q4.gguf
│   ├── embeddings/
│   └── manifests/
├── workspace/
│   ├── encrypted/
│   ├── plaintext-dev/
│   └── backups/
├── updates/
│   ├── incoming/
│   └── applied/
├── logs/
├── docs/
│   ├── user-guide.pdf
│   ├── privacy-notice.md
│   └── troubleshooting.md
└── config/
    ├── drive.json
    ├── policy.json
    └── checksums.json
```

`drive.json` example:

```json
{
  "product": "Private AI Drive Lite",
  "drive_format_version": 1,
  "created_at": "2026-06-09T00:00:00Z",
  "edition": "lite",
  "offline_by_default": true,
  "models_dir": "models",
  "workspace_dir": "workspace",
  "allow_network_by_default": false
}
```

`policy.json` example:

```json
{
  "network": {
    "allow_model_downloads": false,
    "allow_update_checks": false,
    "allow_telemetry": false
  },
  "workspace": {
    "encryption_required": true,
    "allow_plaintext_dev_mode": false
  },
  "models": {
    "allow_unverified_models": false,
    "require_manifest": true,
    "require_sha256_match": true
  }
}
```

---

## 7. Main application modules

### 7.1 App shell

Responsibilities:

- startup
- detect drive layout
- load settings
- verify policy
- show onboarding if first run
- start/stop local runtime
- route UI screens

Screens:

- Onboarding
- Home
- Chat
- Documents
- Models
- Settings
- Privacy & Offline Mode
- Diagnostics

### 7.2 Drive detector

Responsibilities:

- identify whether app is running from prepared drive
- find drive root
- validate required directories
- check free space
- detect read/write permissions
- warn if drive is too slow or not writable

Drive detection should support:

- app launched from drive
- app installed on laptop but workspace/models on drive
- developer mode from local repo

### 7.3 Hardware benchmarker

Responsibilities:

- detect OS
- detect CPU
- detect RAM
- detect GPU if possible
- test disk read speed
- test disk write speed
- run short model benchmark if model exists
- classify hardware profile

Profile names:

```text
TINY       8 GB RAM or less, CPU-only
LITE       8–16 GB RAM, modern CPU
BALANCED   16–32 GB RAM
PRO        32 GB+ RAM or useful GPU
UNKNOWN    detection failed
```

Initial recommendations:

| Profile | Chat model | Context | Notes |
|---|---|---|---|
| TINY | Qwen3 1.7B Q4 | 2048 | basic chat only |
| LITE | Qwen3 4B Q4 | 4096 | target default |
| BALANCED | Qwen3 8B Q4 | 4096–8192 | better answers |
| PRO | Qwen3 8B or 14B Q4 | 8192+ | optional |
| UNKNOWN | Qwen3 1.7B Q4 | 2048 | safe fallback |

### 7.4 Model manager

Responsibilities:

- read model manifests
- verify model files exist
- verify checksums
- show installed models
- recommend model based on hardware
- select active chat model
- select active embedding model
- prevent use of unverified model files unless developer mode

Model states:

```text
installed
missing
checksum_failed
unsupported
not_recommended
ready
running
```

### 7.5 Runtime manager

Responsibilities:

- start llama.cpp runtime
- stop runtime
- restart runtime on model switch
- stream tokens to UI
- manage local port
- bind only to localhost
- enforce timeouts
- collect runtime logs
- expose health check

Runtime launch example, pseudocode:

```bash
llama-server \
  --model /models/chat/qwen3-4b-instruct-q4.gguf \
  --ctx-size 4096 \
  --threads auto \
  --host 127.0.0.1 \
  --port <random-local-port>
```

Do not expose the local runtime to the network.

### 7.6 Chat service

Responsibilities:

- create conversations
- stream responses
- save messages
- load history
- support system prompt
- support RAG context injection
- stop generation
- regenerate answer
- export chat transcript

Base system prompt:

```text
You are Private AI Drive Lite, a local offline assistant running on the user's laptop.
You must be helpful, accurate, and honest about uncertainty.
You do not have internet access.
You must not claim to have accessed external services.
When using provided document context, answer only from the context when the question is about those documents.
If the context is insufficient, say what is missing.
For document answers, include citations using the provided source labels.
```

### 7.7 Document ingestion

Responsibilities:

- import files/folders
- extract text
- chunk text
- generate embeddings
- store metadata
- track ingestion status
- allow re-indexing
- allow delete document/index

Ingestion statuses:

```text
queued
extracting
chunking
embedding
indexed
failed
deleted
```

Chunking defaults:

```text
chunk_size_tokens: 500
chunk_overlap_tokens: 80
max_chunks_per_file_mvp: 1000
```

Metadata for each chunk:

```json
{
  "chunk_id": "uuid",
  "document_id": "uuid",
  "source_path": "relative-or-original-path",
  "source_title": "Contract.pdf",
  "page_number": 4,
  "section": null,
  "text": "chunk text",
  "token_count": 421,
  "embedding_model_id": "embedding-model-id",
  "created_at": "iso-date"
}
```

### 7.8 RAG service

Responsibilities:

- embed user query
- retrieve top chunks
- optionally deduplicate by document/page
- build grounded prompt
- request answer from chat runtime
- require citations
- show source snippets

Default retrieval settings:

```text
top_k_initial: 12
top_k_final: 6
max_context_tokens: 2500
min_similarity_threshold: configurable
```

Grounded answer prompt template:

```text
You are answering a question using local documents.

Rules:
- Use only the document excerpts below when the question is about the documents.
- If the excerpts do not contain enough information, say so.
- Do not invent citations.
- Cite sources inline using [S1], [S2], etc.
- Keep the answer concise unless the user asks for detail.

Question:
{{user_question}}

Document excerpts:
{{numbered_context_chunks}}

Answer:
```

Source context format:

```text
[S1] File: Contract.pdf | Page: 4
"...chunk text..."

[S2] File: Terms.docx | Section: Liability
"...chunk text..."
```

### 7.9 Workspace manager

Responsibilities:

- create workspace
- unlock workspace
- lock workspace
- store settings
- store chats
- store imported docs or references
- store embeddings
- store logs
- support backup/export later

Workspace modes:

```text
encrypted
plaintext_dev
```

For MVP developer speed, plaintext mode is allowed only when:

- environment variable enables it, or
- policy allows it, or
- app is running in dev mode

Commercial preconfigured drives should default to encrypted mode.

### 7.10 Privacy/offline module

Responsibilities:

- show clear offline status
- show data storage locations
- explain no-cloud behavior
- warn before any network action
- record whether user enabled internet for model downloads
- provide privacy export/delete controls later

Required UI text:

```text
Private AI Drive Lite runs models locally on your laptop.
Your prompts, documents, embeddings, and chat history stay on this device/drive unless you explicitly export them.
This app does not send your data to cloud AI providers.
```

### 7.11 Diagnostics

Responsibilities:

- show app version
- show runtime version
- show selected model
- show workspace path
- show drive path
- show hardware profile
- show runtime health
- show recent local logs
- run model verification
- run benchmark again

Diagnostics must not upload logs.

---

## 8. Data model

Use SQLite for MVP.

### 8.1 Tables

#### settings

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### conversations

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  model_id TEXT,
  mode TEXT NOT NULL DEFAULT 'chat'
);
```

#### messages

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_count INTEGER,
  citations_json TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
```

#### documents

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_path TEXT,
  stored_path TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### chunks

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_label TEXT NOT NULL,
  page_number INTEGER,
  section_label TEXT,
  token_count INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
```

#### embeddings

Actual schema depends on vector backend. Minimal metadata:

```sql
CREATE TABLE embeddings (
  chunk_id TEXT PRIMARY KEY,
  embedding_model_id TEXT NOT NULL,
  vector_blob BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);
```

#### runtime_events

```sql
CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
```

### 8.2 IDs

Use UUID v4 or ULID consistently.

### 8.3 Timestamps

Use ISO 8601 UTC strings.

---

## 9. API boundaries

### 9.1 Frontend-to-backend commands

Tauri command examples:

```ts
getAppStatus(): Promise<AppStatus>
getDriveStatus(): Promise<DriveStatus>
runBenchmark(): Promise<BenchmarkResult>
listModels(): Promise<ModelInfo[]>
selectModel(modelId: string): Promise<void>
startRuntime(modelId: string): Promise<RuntimeStatus>
stopRuntime(): Promise<void>
createConversation(): Promise<Conversation>
sendChatMessage(conversationId: string, message: string, options: ChatOptions): Promise<StreamHandle>
importDocuments(paths: string[]): Promise<ImportJob>
getImportJob(jobId: string): Promise<ImportJobStatus>
askDocuments(conversationId: string, question: string): Promise<StreamHandle>
listDocuments(): Promise<DocumentInfo[]>
deleteDocument(documentId: string): Promise<void>
getSettings(): Promise<AppSettings>
updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
```

### 9.2 Internal services

Rust modules should have clean boundaries:

```rust
trait ModelRuntime {
    fn start(&self, config: RuntimeConfig) -> Result<RuntimeHandle>;
    fn stop(&self) -> Result<()>;
    fn health(&self) -> Result<RuntimeHealth>;
    fn chat_stream(&self, request: ChatRequest) -> Result<TokenStream>;
}

trait Embedder {
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

trait DocumentParser {
    fn parse(&self, path: &Path) -> Result<ParsedDocument>;
}

trait VectorIndex {
    fn upsert(&self, chunks: &[EmbeddedChunk]) -> Result<()>;
    fn search(&self, query: Vec<f32>, top_k: usize) -> Result<Vec<SearchResult>>;
}
```

---

## 10. UI requirements

### 10.1 Visual principles

The UI should feel:

- simple
- trustworthy
- offline-first
- calm
- non-technical
- privacy-focused

Avoid exposing raw technical details on the main screens.

### 10.2 Home screen

Show:

- Offline Mode status
- selected model
- hardware profile
- quick actions:
  - Start Chat
  - Ask Documents
  - Import Documents
  - Run Benchmark
- privacy reassurance

Example:

```text
Private AI Drive Lite is ready.

Offline Mode: ON
Active model: Qwen3 4B
Hardware profile: Lite
Workspace: Encrypted

[Start Chat] [Import Documents] [Ask My Documents]
```

### 10.3 Chat screen

Features:

- conversation list
- message stream
- stop generation
- regenerate
- copy
- model indicator
- optional mode selector:
  - Fast
  - Balanced
  - Deep if available

### 10.4 Documents screen

Features:

- import files/folder
- show indexed documents
- status per file
- remove/re-index
- ask selected documents
- show extraction errors

### 10.5 Models screen

Features:

- installed models
- missing models
- recommended model
- verify checksums
- select model
- show model license
- show approximate hardware requirements

### 10.6 Settings screen

Sections:

- Privacy & Offline Mode
- Workspace
- Models
- Performance
- Developer Mode
- About

### 10.7 Diagnostics screen

Show:

- drive speed
- RAM
- OS
- runtime status
- logs
- benchmark result
- model checksums
- local paths

---

## 11. Benchmarking and hardware profiles

### 11.1 Benchmark goals

The benchmark should answer:

- Can this machine run a model?
- Which model should be selected?
- What context size is safe?
- Is the external drive fast enough?
- Is the runtime installed correctly?

### 11.2 Minimum benchmark steps

1. Read system RAM.
2. Read CPU core count.
3. Detect OS and architecture.
4. Detect GPU if feasible.
5. Measure sequential read speed on drive.
6. Measure random-ish read/write small file performance.
7. If model exists, run short prompt:
   - prompt: “Write one sentence about privacy.”
   - measure time to first token
   - measure tokens/sec for 64 tokens
8. Save benchmark result.

### 11.3 Hardware classification

Pseudocode:

```ts
if ramGb <= 8:
  profile = "TINY"
else if ramGb <= 16:
  profile = "LITE"
else if ramGb <= 32:
  profile = "BALANCED"
else:
  profile = "PRO"

if benchmarkTokensPerSecond is very low:
  downgrade one profile

if driveReadMbps < threshold:
  warn user but do not block
```

### 11.4 User-facing language

Do not say:

```text
Your hardware is bad.
```

Say:

```text
Your laptop is best suited for Fast Mode. Larger models may run slowly.
```

---

## 12. Packaging

### 12.1 Developer package

Commands should eventually be:

```bash
git clone https://github.com/OUR_ORG/private-ai-drive-lite.git
cd private-ai-drive-lite
pnpm install
pnpm dev
```

Drive preparation:

```bash
pnpm prepare-drive --target /Volumes/PRIVATE_AI_DRIVE
```

Windows:

```powershell
.\scripts\prepare-drive.ps1 -Target E:\
```

### 12.2 Commercial drive package

The commercial drive should include:

- signed app binaries
- runtime binaries
- model manifests
- selected model weights
- checksums
- user guide
- privacy notice
- troubleshooting guide
- no user-specific data
- first-run onboarding

### 12.3 Updates

MVP:

- manual update via downloaded package
- verify checksum/signature
- replace app/runtime/model manifests

Later:

- optional update check if user enables internet
- enterprise offline update bundles

---

## 13. Model licensing rules

Every model must have a manifest with:

- model name
- upstream source
- license
- commercial-use status
- attribution requirements
- model file hash
- quantization source
- date added
- notes

Do not bundle a model unless its license has been reviewed.

Manifest field:

```yaml
license_review:
  status: pending | approved | rejected
  reviewed_by: null
  reviewed_at: null
  notes: ""
```

For MVP development, allow local developer models with:

```yaml
license_review.status: pending
```

For preconfigured commercial drives, require:

```yaml
license_review.status: approved
```

---

## 14. Security and privacy docs

Create these files early:

### SECURITY.md

Include:

- supported versions
- how to report vulnerabilities
- local threat model
- known limitations
- no bug bounty initially unless funded

### PRIVACY.md

Include:

- no telemetry
- no cloud processing
- local data types
- where data is stored
- how to delete workspace
- model download/update caveat
- offline mode explanation

### docs/security-model.md

Include:

- assets
- threats
- mitigations
- out of scope
- future improvements

---

## 15. Testing strategy

### 15.1 Unit tests

Test:

- path handling
- manifest parsing
- checksum verification
- model recommendation
- chunking
- citation formatting
- policy parsing
- workspace settings

### 15.2 Integration tests

Test:

- import text document
- chunk document
- generate mock embeddings
- retrieve chunks
- build RAG prompt
- store conversation
- verify no network calls in core path

Use mock runtime for tests.

### 15.3 Manual MVP test

A human should verify:

1. Fresh clone starts.
2. App opens.
3. Model manifests load.
4. Missing model is shown clearly.
5. Runtime starts when model exists.
6. Chat works.
7. Import `.txt` file.
8. Ask a question.
9. Answer includes citation.
10. Disable internet and repeat.
11. Move workspace path and repeat.
12. App exits and runtime stops.

---

## 16. Milestones

### Milestone 0 — Repository skeleton

Acceptance criteria:

- repo structure exists
- README created
- CLAUDE.md present
- license placeholder
- desktop app starts with placeholder UI
- no model runtime yet

### Milestone 1 — App shell and drive layout

Acceptance criteria:

- app detects workspace path
- app creates required directories
- settings load/save
- home screen shows status
- diagnostics screen shows OS and paths

### Milestone 2 — Model manifests and runtime launcher

Acceptance criteria:

- manifests load
- model existence/checksum status shown
- llama.cpp sidecar can start/stop
- runtime health check works
- selected local model can answer a simple prompt

### Milestone 3 — Basic chat

Acceptance criteria:

- user can create conversation
- user can send message
- response streams into UI
- conversation persists locally
- stop generation works

### Milestone 4 — Document import

Acceptance criteria:

- user imports txt/md/pdf/docx
- text is extracted
- chunks are created
- metadata stored
- failures displayed clearly

### Milestone 5 — Embeddings and search

Acceptance criteria:

- chunks embedded locally
- query embedding generated locally
- top chunks returned
- no external network calls

### Milestone 6 — RAG chat with citations

Acceptance criteria:

- user asks question over documents
- relevant chunks injected
- answer cites sources
- source snippets visible in UI

### Milestone 7 — Hardware benchmark and model recommendation

Acceptance criteria:

- RAM/OS/CPU detected
- drive speed checked
- profile assigned
- recommended model shown
- warning for weak hardware

### Milestone 8 — Privacy/offline hardening

Acceptance criteria:

- visible offline mode
- network actions disabled by default
- privacy page complete
- logs local only
- plaintext developer mode separated

### Milestone 9 — Encrypted workspace

Acceptance criteria:

- user can create password-protected workspace
- chat/doc/index data encrypted or protected according to design
- app can lock/unlock workspace
- password not stored

### Milestone 10 — Preconfigured drive beta

Acceptance criteria:

- prepare-drive script works
- app launches from drive
- models verified
- user guide included
- non-technical user can complete core demo

---

## 17. MVP demo script

Use this as the canonical demo:

1. Laptop has Wi-Fi turned off.
2. User plugs in Private AI Drive Lite.
3. User launches app.
4. Home screen says:
   - Offline Mode: ON
   - Active model: Qwen3 4B
   - Workspace: Encrypted
5. User opens Documents.
6. User imports `sample-contract.pdf`.
7. App indexes file locally.
8. User asks:
   - “What are the termination rights in this contract?”
9. App responds with:
   - concise answer
   - citations to pages/sections
   - source snippets
10. User asks:
   - “Draft a polite email summarizing the risk.”
11. App drafts email locally.
12. User closes app.
13. Runtime stops.
14. No network activity occurred.

---

## 18. Sample app copy

### 18.1 Offline statement

```text
Offline Mode is on. Private AI Drive Lite runs the AI model on your laptop.
Your prompts, documents, embeddings, and chat history stay local.
```

### 18.2 Hardware warning

```text
Your laptop is best suited for Fast Mode.
Balanced Mode may work, but responses can be slower.
```

### 18.3 Missing model message

```text
The selected model is not installed on this drive.
Add the model file to the models folder or choose another installed model.
```

### 18.4 Document limitation

```text
Some documents may not extract correctly, especially scanned PDFs.
OCR is not included in this Lite MVP.
```

### 18.5 Citation uncertainty

```text
I could not find enough information in the indexed documents to answer confidently.
Try importing more documents or rephrasing the question.
```

---

## 19. Future editions

### 19.1 Office / Knowledge Drive

Adds:

- better RAG
- reranker
- folder-level knowledge bases
- contract review workflow
- GDPR/DPIA assistant
- audit logs
- better encryption
- admin settings

### 19.2 Reasoning Drive Pro

Adds:

- larger models
- coding assistant
- local tool execution
- project workspaces
- spreadsheet analysis
- long-context workflows where hardware permits

### 19.3 Studio Drive

Adds:

- local image generation
- ComfyUI or InvokeAI backend
- SDXL/FLUX/other model packs, subject to licensing
- prompt assistant
- brand/style templates
- asset library

Studio is intentionally not part of Lite MVP.

### 19.4 Enterprise Drive

Adds:

- policy enforcement
- model allowlist
- signed offline updates
- central provisioning
- audit controls
- compliance documentation
- admin lock
- optional hardware encrypted drive

---

## 20. Open questions

Track these in issues:

1. Tauri vs Electron final choice.
2. Best local vector store for cross-platform MVP.
3. Best embedding model for CPU-only multilingual use.
4. Exact Qwen3 GGUF quantization files to recommend.
5. Whether to use llama-server or direct library integration.
6. How much encryption is feasible in v0.1 vs v0.2.
7. Best Windows packaging path for running from external drive.
8. How to code-sign commercial app builds.
9. Whether model downloads should be in-app or external-only.
10. How to implement no-network enforcement beyond policy/UX.
11. What hardware SKU to use for commercial Lite drive.
12. How to manage model license review.
13. How to test drive portability across Windows/macOS/Linux.
14. Whether to support Apple Silicon MLX backend in v1.
15. Whether to support scanned PDF OCR in Lite or reserve for Pro.

---

## 21. Initial implementation plan for Claude Code

Start here.

### Step 1 — Create repo skeleton

Implement:

- root `package.json`
- `apps/desktop`
- Tauri starter app
- basic README
- basic docs
- placeholder screens

Do not implement AI yet.

### Step 2 — Add drive/workspace manager

Implement:

- detect app data directory
- create workspace directories
- load/save settings
- show status in UI

### Step 3 — Add model manifest loader

Implement:

- manifest schema
- example manifests
- manifest validation
- model existence check
- checksum function
- Models screen

### Step 4 — Add mock chat runtime

Implement:

- `MockRuntime`
- streaming fake response
- chat UI
- conversation persistence

This allows UI/data development without model files.

### Step 5 — Add llama.cpp runtime

Implement:

- sidecar configuration
- start/stop
- health check
- prompt endpoint
- streaming endpoint if supported
- error handling

### Step 6 — Add document pipeline

Implement:

- txt/md parser first
- chunker
- SQLite metadata
- mock embeddings
- search placeholder

### Step 7 — Add real embeddings/search

Implement:

- local embedding model
- vector index
- top-k retrieval
- RAG prompt

### Step 8 — Add RAG citations

Implement:

- source chunk formatting
- citation display
- source snippet panel

### Step 9 — Add benchmarker

Implement:

- RAM/OS/CPU
- drive speed
- profile recommendation
- UI warnings

### Step 10 — Harden privacy

Implement:

- no-network-by-default policy
- privacy page
- local logs only
- start encrypted workspace design

---

## 22. Definition of done for MVP Lite

The MVP Lite is done when:

- app builds on at least one OS
- architecture supports Windows/macOS/Linux
- local model chat works
- local document Q&A works
- citations work
- model manifests work
- drive layout works
- user data stays local
- privacy docs exist
- setup script exists
- benchmark recommendation exists
- non-technical demo is possible
- no cloud API dependency exists
- no model weights are in git
- README explains DIY setup
- commercial drive layout is documented

---

## 23. Development philosophy

Private AI Drive Lite is not trying to beat frontier cloud models.

It is trying to be:

- private
- offline
- understandable
- useful
- portable
- open-source
- honest about limits
- easy for normal users

The killer feature is not raw model size.

The killer feature is:

> Plug in a trusted drive, ask questions about private documents, and keep everything local.

