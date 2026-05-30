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
      if (statusCode === 404) return null;
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
    } catch {
      return null;
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
    } catch {
      return null;
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

function createStorage(): StorageProvider {
  switch (process.env.STORAGE_PROVIDER) {
    case "azure":
      return new AzureBlobStorage();
    case "s3":
      return new S3Storage();
    default:
      return new LocalStorage();
  }
}

export const storage = createStorage();
