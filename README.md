# RepoIntel

> AI-powered document intelligence API. Index docs from GitHub, extract entities & relationships, and query everything via RAG chat.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/repointel)

## What it does

Point RepoIntel at a GitHub repo containing documents (`.docx`, `.pdf`, `.xlsx`, `.csv`, `.md`). It will:

1. **Index** all documents — parse, chunk, and generate vector embeddings
2. **Extract entities** — decisions, dependencies, gaps, stakeholders, milestones, workflows
3. **Detect relationships** — blocks, owns, references, supersedes
4. **Answer questions** — RAG-powered chat with source citations and entity references
5. **Auto-update** — GitHub webhooks trigger re-indexing on push

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ask` | POST | RAG chat — stream answers with citations |
| `/api/entities` | GET | List extracted entities (filter by type, domain, status) |
| `/api/entities/[id]` | GET | Get entity with relations |
| `/api/index` | POST | Trigger document indexing |
| `/api/index` | GET | Poll indexing status |
| `/api/health` | GET | System health check |
| `/api/dashboard/summary` | GET | Document & entity counts |
| `/api/changes` | GET | Change delta since last index |
| `/api/changes/history` | GET | Historical index snapshots |
| `/api/webhooks/github` | POST | GitHub push webhook for auto-reindex |
| `/api/debug` | GET | Test extraction pipeline |

### Chat API

```bash
curl -X POST https://your-app.railway.app/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the key decisions documented?"}' \
  --no-buffer
```

Response is a Server-Sent Events stream:
```
data: {"type": "sources", "sources": [...]}
data: {"type": "entities", "entities": [...], "intent": "synthesis"}
data: {"type": "text", "text": "Based on the indexed documents..."}
data: {"type": "done"}
```

### Entity API

```bash
curl https://your-app.railway.app/api/entities?type=decision&status=open
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub personal access token (read access to your repo) |
| `GITHUB_REPO` | GitHub repo in `owner/repo` format |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_MODE` | `local` | `local` (Ollama) or `cloud` (API keys) |
| `ADMIN_PASSWORD` | `admin` | Password for indexing operations via UI |
| `MISTRAL_API_KEY` | — | Mistral API key (chat, classification, extraction) |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (alternative chat provider) |
| `OPENAI_API_KEY` | — | OpenAI API key (alternative chat/embedding provider) |
| `PROJECT_DOMAINS` | — | JSON array of domain names, e.g. `["backend","frontend","infra"]` |
| `OLLAMA_CHAT_MODEL` | `llama3.2:1b` | Ollama model for chat (local mode) |
| `DATA_DIR` | `/data` | Persistent data directory |

## AI Modes

### Local Mode (`AI_MODE=local`, default)

Runs Ollama locally inside the container. No API keys needed. Includes:
- `nomic-embed-text` for embeddings
- `llama3.2:1b` for chat and extraction

Best for: privacy-sensitive deployments, development, cost-conscious usage.

### Cloud Mode (`AI_MODE=cloud`)

Uses cloud AI APIs. Smaller container, faster startup, better model quality. Set one or more API keys:
- `MISTRAL_API_KEY` — recommended, used for chat + classification + extraction
- `OPENAI_API_KEY` — alternative for embeddings and chat
- `ANTHROPIC_API_KEY` — alternative for chat

Best for: production deployments, higher quality responses.

## Tech Stack

- **Runtime**: Next.js 14 (App Router) + Node.js 20
- **Database**: SQLite (better-sqlite3) for structured data
- **Vector Store**: ChromaDB for embeddings
- **AI**: Ollama (local) or cloud APIs (Mistral/OpenAI/Anthropic)
- **Parsing**: mammoth (DOCX), pdf-parse (PDF), xlsx (Excel), papaparse (CSV), remark (Markdown)
- **UI**: Carbon Design System

## Supported Document Formats

| Format | Parser | Structure Extraction |
|--------|--------|---------------------|
| .docx  | mammoth | Headings (H1-H6) |
| .xlsx/.xls | SheetJS | Sheets, header rows |
| .csv   | papaparse | Header columns |
| .md    | remark | ATX headings (# - ######) |
| .pdf   | pdf-parse | Pages, heuristic headings |

## Local Development

```bash
# Install dependencies
npm install

# Start ChromaDB (in a separate terminal)
pip install chromadb
chroma run --path ./data/chroma

# Start Ollama (local mode, in a separate terminal)
ollama serve
ollama pull nomic-embed-text
ollama pull llama3.2:1b

# Set environment variables
export GITHUB_TOKEN=your_token
export GITHUB_REPO=owner/repo

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Click **"Index New Files"** to run the first index, then navigate to `/chat` to ask questions.

## GitHub Webhook Setup

1. Go to your repo's Settings > Webhooks > Add webhook
2. **URL**: `https://your-app.railway.app/api/webhooks/github`
3. **Content type**: `application/json`
4. **Events**: Just the push event
5. Documents will auto-reindex when you push changes

## Project Structure

```
app/                    # Next.js App Router
  api/
    ask/                # POST /api/ask — RAG Q&A (SSE stream)
    entities/           # GET /api/entities — entity CRUD
    health/             # GET /api/health — service health
    index/              # POST /api/index — indexing pipeline
    webhooks/github/    # POST /api/webhooks/github — auto-reindex
  chat/                 # Chat UI
  domains/[domain]/     # Domain entity detail page
lib/
  ai/                   # Classification, extraction, retrieval, prompts
  embeddings/           # Embedding provider (Ollama)
  github/               # GitHub API client
  indexing/             # Chunking + indexing pipeline
  parsers/              # Document parsers (DOCX, PDF, XLSX, CSV, MD)
  storage/              # SQLite (db.ts) + ChromaDB (vectorstore.ts)
Dockerfile              # Single-container build
start.sh                # Startup: ChromaDB + Ollama (if local) + Next.js
railway.toml            # Railway deployment config
```

## License

MIT
