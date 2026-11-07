import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { GrantSigner, ObjectHead, ObjectStore, SignedPut } from "../ports";
import type { GrantItem } from "../Wire";

/**
 * Presigned URLs carry no checksum parameter. The frozen v1 grant contract sends the hex
 * X-Clippy-SHA256 header, which S3 ignores; integrity is enforced by server-side
 * verification at completion. WHEN_REQUIRED stops the SDK from signing a checksum of an
 * empty body into presigned PUT URLs.
 */
export function createS3Client(region?: string): S3Client {
  return new S3Client({
    region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const missing = (error: unknown): boolean =>
  error instanceof NotFound ||
  error instanceof NoSuchKey ||
  (error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404);

export class S3Objects implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      // Only a full-object SHA-256 is comparable with the granted hash; otherwise the
      // engine reads and hashes the bytes itself.
      const sha256 =
        result.ChecksumSHA256 && result.ChecksumType !== "COMPOSITE"
          ? Buffer.from(result.ChecksumSHA256, "base64").toString("hex")
          : undefined;
      return { byteLength: result.ContentLength ?? 0, sha256 };
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${maxBytes}`,
        }),
      );
      return result.Body ? await result.Body.transformToByteArray() : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (!batch.length) continue;
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
        }),
      );
      if (result.Errors?.length)
        throw new Error(`S3 delete failed for ${result.Errors.length} objects`);
    }
  }

  async removePrefix(prefix: string): Promise<void> {
    if (!/^u\/[A-Za-z0-9_-]+\/$/.test(prefix))
      throw new Error("Refusing to delete outside one owner prefix");
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      await this.remove(
        (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])),
      );
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

const secondsUntil = (expiresAt: string): number =>
  Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));

export class S3Signer implements GrantSigner {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async signPut(input: {
    key: string;
    item: GrantItem;
    expiresAt: string;
  }): Promise<SignedPut> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.item.contentType,
      IfNoneMatch: "*",
    });
    const putURL = await getSignedUrl(this.client, command, {
      expiresIn: Math.min(900, secondsUntil(input.expiresAt)),
      // Both headers are part of the signature, so the device must send them exactly.
      signableHeaders: new Set(["content-type", "if-none-match"]),
    });
    return { putURL };
  }

  async signGet(input: { key: string; expiresAt: string }): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseCacheControl: "no-store",
      }),
      { expiresIn: Math.min(60, secondsUntil(input.expiresAt)) },
    );
  }
}
