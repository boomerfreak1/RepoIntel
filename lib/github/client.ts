/**
 * GitHub API client for connecting to a project document repository.
 * Uses the GitHub REST API via personal access token.
 */

interface GitHubFile {
  path: string;
  name: string;
  sha: string;
  size: number;
  type: "file" | "dir";
  download_url: string | null;
}

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

interface GitHubFileContent {
  path: string;
  content: string;
  sha: string;
  size: number;
  encoding: string;
}

export class GitHubClient {
  private token: string;
  private owner: string;
  private repo: string;
  private baseUrl = "https://api.github.com";

  constructor(options?: { token?: string; repo?: string }) {
    const token = options?.token ?? process.env.GITHUB_TOKEN;
    const repoSlug = options?.repo ?? process.env.GITHUB_REPO;

    if (!token) {
      throw new Error(
        "GitHub token is required. Set GITHUB_TOKEN environment variable."
      );
    }
    if (!repoSlug) {
      throw new Error(
        "GitHub repo is required. Set GITHUB_REPO environment variable (format: owner/repo)."
      );
    }

    const parts = repoSlug.split("/");
    if (parts.length !== 2) {
      throw new Error(
        `Invalid GITHUB_REPO format: "${repoSlug}". Expected "owner/repo".`
      );
    }

    this.token = token;
    this.owner = parts[0];
    this.repo = parts[1];
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub API error ${response.status}: ${response.statusText} - ${body}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * List all files in the repository recursively using the Git Trees API.
   * Returns flat list of file paths (excludes directories).
   */
  async listFiles(branch = "main"): Promise<GitHubTreeItem[]> {
    const tree = await this.request<{
      sha: string;
      tree: GitHubTreeItem[];
      truncated: boolean;
    }>(
      `/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=1`
    );

    if (tree.truncated) {
      console.warn(
        "GitHub tree response was truncated. Repository may have too many files."
      );
    }

    return tree.tree.filter((item) => item.type === "blob");
  }

  /**
   * Fetch the contents of a single file by path.
   * Returns decoded content as a string (for text files).
   */
  async getFileContent(
    path: string,
    branch = "main"
  ): Promise<{ content: string; sha: string; size: number }> {
    const file = await this.request<GitHubFileContent>(
      `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(path)}?ref=${branch}`
    );

    // GitHub returns base64-encoded content for files under 1MB
    const content = Buffer.from(file.content, "base64").toString("utf-8");

    return {
      content,
      sha: file.sha,
      size: file.size,
    };
  }

  /**
   * Fetch raw file content using the download URL.
   * Better for larger files as it doesn't base64 encode.
   */
  async getRawContent(path: string, branch = "main"): Promise<string> {
    const url = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${branch}/${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch raw content for ${path}: ${response.status}`
      );
    }

    return response.text();
  }

  /**
   * List contents of a specific directory.
   */
  async listDirectory(
    path: string,
    branch = "main"
  ): Promise<GitHubFile[]> {
    return this.request<GitHubFile[]>(
      `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(path)}?ref=${branch}`
    );
  }

  /**
   * Verify the connection to the repository.
   */
  async healthCheck(): Promise<{
    connected: boolean;
    repo: string;
    defaultBranch: string;
    error?: string;
  }> {
    try {
      const repo = await this.request<{
        full_name: string;
        default_branch: string;
      }>(`/repos/${this.owner}/${this.repo}`);

      return {
        connected: true,
        repo: repo.full_name,
        defaultBranch: repo.default_branch,
      };
    } catch (error) {
      return {
        connected: false,
        repo: `${this.owner}/${this.repo}`,
        defaultBranch: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Singleton instance using environment variables */
let _client: GitHubClient | null = null;

export function getGitHubClient(): GitHubClient {
  if (!_client) {
    _client = new GitHubClient();
  }
  return _client;
}
