/**
 * Webhook payload keys that change on essentially every update and are not
 * something the merchant did.
 *
 * `updated_at` is the clearest case: it changes by definition on every write,
 * so it can never distinguish a real edit from a no-op. `id`, `created_at`,
 * `admin_graphql_api_id` and the *_ids/*_gids collections are identity and
 * bookkeeping. `image`/`image_id` are the denormalised featured-image echo of
 * a change already reported by `images`.
 *
 * This list previously existed as four separate copies that had already begun
 * to disagree, which is how a field ends up filtered on one screen and leaking
 * on another. One definition, imported everywhere.
 */
export const NOISE_KEYS = new Set([
  "id",
  "admin_graphql_api_id",
  "created_at",
  "updated_at",
  "published_scope",
  "variant_ids",
  "variant_gids",
  "image",
  "image_id",
]);

/**
 * True when a diff found changes but every one of them is bookkeeping — i.e.
 * nothing the merchant would recognise as an edit.
 *
 * Deliberately false for an empty list: an empty `changedFields` means "no
 * diff was computed" (no baseline yet), not "nothing changed", and the
 * consumers treat that as "assume it changed". Conflating the two would make
 * genuinely-unknown events look like no-ops.
 */
export function isNoiseOnly(changedFields: string[]): boolean {
  return (
    changedFields.length > 0 && changedFields.every((f) => NOISE_KEYS.has(f))
  );
}

/** Merchant-facing names for the raw webhook keys. */
export const FIELD_LABELS: Record<string, string> = {
  title: "title",
  body_html: "description",
  vendor: "vendor",
  product_type: "product type",
  handle: "handle",
  tags: "tags",
  status: "status",
  template_suffix: "theme template",
  variants: "variant details",
  images: "images",
  options: "options",
  published_at: "publishing",
  metafields: "metafields",
};

/** Drops bookkeeping keys and renames the rest for display. */
export function visibleFieldLabels(changedFields: string[]): string[] {
  return changedFields
    .filter((f) => !NOISE_KEYS.has(f))
    .map((f) => FIELD_LABELS[f] ?? f);
}
