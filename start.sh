#!/bin/bash
set -e

DATA_DIR="${DATA_DIR:-/data}"
CHROMA_PORT="${CHROMA_PORT:-8000}"
AI_MODE="${AI_MODE:-local}"

echo "[start] AI_MODE=$AI_MODE"
echo "[start] Creating data directories..."
mkdir -p "$DATA_DIR/chroma"

# Start ChromaDB in the background
echo "[start] Starting ChromaDB on port $CHROMA_PORT..."
/opt/chroma-venv/bin/chroma run \
  --path "$DATA_DIR/chroma" \
  --host 0.0.0.0 \
  --port "$CHROMA_PORT" \
  > "$DATA_DIR/chroma.log" 2>&1 &
CHROMA_PID=$!

if [ "$AI_MODE" = "local" ]; then
  # Start Ollama in the background
  echo "[start] Starting Ollama..."
  ollama serve &
  OLLAMA_PID=$!

  # Wait for Ollama to be ready
  echo "[start] Waiting for Ollama to be ready..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo "[start] Ollama is ready."
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "[start] WARNING: Ollama did not start within 30 seconds."
    fi
    sleep 1
  done

  # Verify nomic-embed-text is available
  if curl -sf http://localhost:11434/api/tags | grep -q "nomic-embed-text"; then
    echo "[start] nomic-embed-text model is loaded."
  else
    echo "[start] Pulling nomic-embed-text model..."
    ollama pull nomic-embed-text
  fi

  # Verify chat model is available
  OLLAMA_CHAT_MODEL="${OLLAMA_CHAT_MODEL:-llama3.2:1b}"
  if curl -sf http://localhost:11434/api/tags | grep -q "llama3.2"; then
    echo "[start] $OLLAMA_CHAT_MODEL model is loaded."
  else
    echo "[start] Pulling $OLLAMA_CHAT_MODEL model..."
    ollama pull "$OLLAMA_CHAT_MODEL"
  fi
else
  echo "[start] Cloud AI mode — skipping Ollama startup."
  echo "[start] Ensure ANTHROPIC_API_KEY, OPENAI_API_KEY, or MISTRAL_API_KEY is set."
fi

# Wait for ChromaDB to be ready
echo "[start] Waiting for ChromaDB to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$CHROMA_PORT/api/v1/heartbeat" > /dev/null 2>&1 || \
     curl -sf "http://localhost:$CHROMA_PORT/api/v2/heartbeat" > /dev/null 2>&1; then
    echo "[start] ChromaDB is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[start] WARNING: ChromaDB did not start within 30 seconds. Check $DATA_DIR/chroma.log"
    cat "$DATA_DIR/chroma.log" 2>/dev/null || true
  fi
  sleep 1
done

# Start Next.js
echo "[start] Starting Next.js on port ${PORT:-3000}..."
exec npx next start -p "${PORT:-3000}"
