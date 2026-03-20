import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { isSupported } from "@/lib/parsers";
import { indexFile } from "@/lib/indexing/pipeline";
import { deleteDocument, getDocumentByPath, deleteEntitiesByDocumentId } from "@/lib/storage/db";
import { deleteDocumentChunks } from "@/lib/storage/vectorstore";

/**
 * POST /api/webhooks/github — GitHub push event handler.
 * Verifies webhook signature (GITHUB_WEBHOOK_SECRET), then triggers
 * incremental re-indexing for changed files.
 */

interface GitHubPushPayload {
  ref: string;
  before: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

function verifySignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", secret);
  const digest = `sha256=${hmac.update(payload).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const event = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");

  // Verify webhook signature if secret is configured
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    if (!verifySignature(body, signature, secret)) {
      console.warn("[webhook] Invalid signature rejected");
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }
  }

  // Handle ping event (sent when webhook is first configured)
  if (event === "ping") {
    return NextResponse.json({ message: "pong" });
  }

  // Only process push events
  if (event !== "push") {
    return NextResponse.json({ message: `Ignored event: ${event}` });
  }

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  // Collect all changed files from all commits
  const changedFiles = new Set<string>();
  const removedFiles = new Set<string>();

  for (const commit of payload.commits) {
    commit.added.forEach((f) => changedFiles.add(f));
    commit.modified.forEach((f) => changedFiles.add(f));
    commit.removed.forEach((f) => removedFiles.add(f));
  }

  // Net removal wins if a file was both added and removed
  for (const f of removedFiles) {
    changedFiles.delete(f);
  }

  console.log(
    `[webhook] Push to ${payload.repository.full_name} by ${payload.sender.login}:`,
    {
      branch: payload.ref,
      changed: Array.from(changedFiles),
      removed: Array.from(removedFiles),
    }
  );

  // Process changes in the background (don't block the webhook response)
  const results = {
    indexed: [] as string[],
    removed: [] as string[],
    skipped: [] as string[],
    errors: [] as Array<{ file: string; error: string }>,
  };

  // Handle removed files
  for (const filePath of removedFiles) {
    try {
      const doc = getDocumentByPath(filePath);
      if (doc) {
        deleteEntitiesByDocumentId(doc.id);
      }
      deleteDocument(filePath);
      await deleteDocumentChunks(filePath);
      results.removed.push(filePath);
    } catch (error) {
      results.errors.push({
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Handle changed/added files
  for (const filePath of changedFiles) {
    if (!isSupported(filePath)) {
      results.skipped.push(filePath);
      continue;
    }
    try {
      await indexFile(filePath);
      results.indexed.push(filePath);
    } catch (error) {
      results.errors.push({
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("[webhook] Processing complete:", results);

  return NextResponse.json({
    received: true,
    branch: payload.ref,
    ...results,
  });
}
