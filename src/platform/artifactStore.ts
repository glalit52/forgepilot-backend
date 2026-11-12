/**
 * Artifact storage: files produced by execution (test output, and later
 * screenshots and traces). Two drivers behind one interface:
 *  - local: a directory on disk (development, single machine)
 *  - s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO…)
 *
 * Keys always start with the workspace id, so one workspace can never be
 * handed another's file, and a bucket policy can be scoped per prefix.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface ArtifactStore {
  readonly driver: "local" | "s3";
  put(key: string, body: string | Buffer, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  /** Removes every object under a prefix (a deleted workspace, an expired run). */
  removePrefix(prefix: string): Promise<void>;
}

/** Keys are built by the server, but validate anyway: no traversal, no absolute paths. */
export function assertSafeKey(key: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,400}$/.test(key) || key.includes("..") || key.includes("//"))
    throw new Error(`Unsafe artifact key: ${key}`);
  return key;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly driver = "local" as const;
  private root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    const full = resolve(join(this.root, assertSafeKey(key)));
    if (!full.startsWith(this.root + sep)) throw new Error(`Unsafe artifact key: ${key}`);
    return full;
  }

  async put(key: string, body: string | Buffer, contentType: string) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.meta`, contentType);
  }

  async get(key: string) {
    const file = this.path(key);
    try {
      return {
        body: await readFile(file),
        contentType: await readFile(`${file}.meta`, "utf8").catch(() => "application/octet-stream"),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async removePrefix(prefix: string) {
    await rm(this.path(prefix.replace(/\/$/, "")), { recursive: true, force: true });
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  /** Set for S3-compatible services (R2, MinIO). Leave unset for AWS. */
  endpoint?: string;
}

/**
 * S3 driver. Credentials come from the standard AWS chain (environment
 * variables, instance role…), so no keys are handled by this code.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly driver = "s3" as const;
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;

  constructor(private cfg: S3Config) {}

  // Loaded on first use so deployments on local storage never load the AWS SDK.
  private async sdk() {
    const mod = await import("@aws-sdk/client-s3");
    this.clientPromise ??= Promise.resolve(
      new mod.S3Client({
        region: this.cfg.region,
        ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint, forcePathStyle: true } : {}),
      }),
    );
    return { mod, client: await this.clientPromise };
  }

  async put(key: string, body: string | Buffer, contentType: string) {
    const { mod, client } = await this.sdk();
    await client.send(
      new mod.PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: assertSafeKey(key),
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: this.cfg.endpoint ? undefined : "AES256",
      }),
    );
  }

  async get(key: string) {
    const { mod, client } = await this.sdk();
    try {
      const res = await client.send(
        new mod.GetObjectCommand({ Bucket: this.cfg.bucket, Key: assertSafeKey(key) }),
      );
      if (!res.Body) return null;
      return {
        body: Buffer.from(await res.Body.transformToByteArray()),
        contentType: res.ContentType ?? "application/octet-stream",
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw err;
    }
  }

  async removePrefix(prefix: string) {
    const { mod, client } = await this.sdk();
    let token: string | undefined;
    do {
      const page = await client.send(
        new mod.ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: assertSafeKey(prefix),
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length)
        await client.send(
          new mod.DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }),
        );
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
