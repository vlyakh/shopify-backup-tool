import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";

interface StorageProvider {
  put(key: string, data: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * Azure Blob Storage provider.
 */
class AzureBlobStorage implements StorageProvider {
  private container: ContainerClient;

  constructor() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");
    }
    const containerName = process.env.AZURE_STORAGE_CONTAINER || "shopify-backups";
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.container = blobServiceClient.getContainerClient(containerName);
  }

  async put(key: string, data: string): Promise<void> {
    const blob = this.container.getBlockBlobClient(key);
    await blob.upload(data, Buffer.byteLength(data, "utf-8"), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      const blob = this.container.getBlockBlobClient(key);
      const response = await blob.download(0);
      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody as NodeJS.ReadableStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf-8");
    } catch (error: unknown) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      const code = (error as { code?: string })?.code;
      if (statusCode === 404 || code === "BlobNotFound") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const blob = this.container.getBlockBlobClient(key);
      await blob.deleteIfExists();
    } catch {
      // Ignore errors
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      await this.container.getBlockBlobClient(blob.name).deleteIfExists();
    }
  }
}

/**
 * Local filesystem storage for development.
 */
class LocalStorage implements StorageProvider {
  private basePath: string;

  constructor() {
    this.basePath = process.env.STORAGE_LOCAL_PATH || "./storage";
  }

  async put(key: string, data: string): Promise<void> {
    const filePath = path.join(this.basePath, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data, "utf-8");
  }

  async get(key: string): Promise<string | null> {
    try {
      const filePath = path.join(this.basePath, key);
      return await fs.readFile(filePath, "utf-8");
    } catch (error: unknown) {
      // Only "missing" is null; other errors must surface, not look like
      // an absent blob (callers treat null as "no baseline").
      if ((error as { code?: string })?.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = path.join(this.basePath, key);
      await fs.unlink(filePath);
    } catch {
      // File may not exist
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      const dirPath = path.join(this.basePath, prefix);
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }
}

/**
 * S3-compatible storage (AWS S3, DigitalOcean Spaces, Backblaze B2, MinIO).
 */
class S3Storage implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || "shopify-backups";
    this.client = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_KEY || "",
      },
      forcePathStyle: !!process.env.S3_ENDPOINT,
    });
  }

  async put(key: string, data: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/json",
      }),
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await response.Body?.transformToString()) || null;
    } catch (error: unknown) {
      // Only "missing" is null; an outage/auth error must surface, not look
      // like an absent blob (callers treat null as "no baseline").
      const name = (error as { name?: string })?.name;
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      if (list.Contents) {
        for (const obj of list.Contents) {
          if (obj.Key) await this.delete(obj.Key);
        }
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }
}

/**
 * Picks the storage backend from STORAGE_PROVIDER.
 *
 * This used to fall back to LocalStorage for any unrecognised value, which is
 * the worst possible failure mode for a backup product: a blank or mistyped
 * App Service setting sent every backup to the instance's local disk while
 * still reporting COMPLETED, so the merchant's backups looked fine and were
 * not in durable storage. Nothing surfaced the mistake.
 *
 * So: the value is normalised (a stray case or space is a typo, not a
 * different provider), local storage must be asked for by name, and choosing
 * it in production is refused outright — crashing on boot is loud, visible in
 * the Azure log stream, and vastly cheaper than discovering it at restore
 * time. The chosen provider is logged either way.
 */
function createStorage(): StorageProvider {
  const configured = (process.env.STORAGE_PROVIDER ?? "").trim().toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";

  switch (configured) {
    case "azure":
      console.log("[Storage] Using Azure Blob storage");
      return new AzureBlobStorage();
    case "s3":
      console.log("[Storage] Using S3 storage");
      return new S3Storage();
    case "local":
      if (isProduction) {
        throw new Error(
          'STORAGE_PROVIDER="local" is not allowed when NODE_ENV=production: ' +
            "backups would be written to the instance's local disk instead of " +
            'durable storage. Set STORAGE_PROVIDER to "azure" or "s3".',
        );
      }
      console.log("[Storage] Using local filesystem storage");
      return new LocalStorage();
    case "":
      throw new Error(
        "STORAGE_PROVIDER is not set. Set it to 'azure', 's3', or 'local' " +
          "(local is for development only).",
      );
    default:
      throw new Error(
        `STORAGE_PROVIDER="${process.env.STORAGE_PROVIDER}" is not a known ` +
          "provider. Expected 'azure', 's3', or 'local'.",
      );
  }
}

export const storage = createStorage();
