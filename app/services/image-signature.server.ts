/**
 * A STABLE identity for a product's image set — used to decide whether the live
 * images differ from a backup without being fooled by Shopify re-hosting.
 *
 * Restoring images re-ingests each one from its backed-up CDN URL, and Shopify
 * assigns a brand-new media id, a new CDN url, AND a uniquified filename (it
 * appends a 32-char hash when a same-named file already exists — which it always
 * does here, because the backup's own source file is still live in the store).
 * So url, id, and even the basename are NOT stable and must not be compared.
 *
 * What DOES survive re-ingestion: the image's pixel dimensions (same file → same
 * width/height), its altText (we pass it back on restore), and its gallery order.
 * So the signature is (width x height + altText) per image, in order. The backup,
 * the diff query, and the revert media query all capture width, height, altText.
 *
 * Accepts a GraphQL images/media connection ({ nodes: [...] }) or a plain array
 * of { width, height, altText }. Order-sensitive — a reorder is a real change.
 *
 * Known limitation: an image swapped for a different one with identical
 * dimensions AND altText at the same position reads as unchanged. Acceptable —
 * the ChangeLog timeline still records the change, and this avoids the far worse
 * false-"changed"-forever a url/filename compare produces after a revert.
 */
export function imageSignature(images: unknown): string {
  return toNodes(images)
    .map((n) => `${n.width ?? ""}x${n.height ?? ""}|${n.altText ?? ""}`)
    .join("\n");
}

type ImageNode = {
  width?: number | null;
  height?: number | null;
  altText?: string | null;
};

function toNodes(images: unknown): ImageNode[] {
  if (Array.isArray(images)) return images;
  if (
    images &&
    typeof images === "object" &&
    Array.isArray((images as { nodes?: unknown[] }).nodes)
  ) {
    return (images as { nodes: ImageNode[] }).nodes;
  }
  return [];
}
