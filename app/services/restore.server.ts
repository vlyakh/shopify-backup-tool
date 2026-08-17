import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { storage } from "./storage.server";
import { apiVersion } from "../shopify.server";
import type { ResourceType } from "@prisma/client";

/**
 * Context needed for Shopify REST Admin API calls.
 * The AdminApiContext only provides GraphQL, so for resources that require
 * the REST API (blog articles, theme assets), we need the shop domain and
 * access token to make direct HTTP calls.
 */
export interface RestContext {
  shop: string;
  accessToken: string;
}

/**
 * Make a REST Admin API request using fetch.
 */
async function shopifyRestRequest(
  rest: RestContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `https://${rest.shop}/admin/api/${apiVersion}/${path}`;
  const headers: Record<string, string> = {
    "X-Shopify-Access-Token": rest.accessToken,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify REST API ${method} ${path} failed (${response.status}): ${text}`);
  }

  return response.json();
}

const PRODUCT_SET_MUTATION = `#graphql
  mutation productSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product {
        id
        title
        variants(first: 100) {
          nodes {
            id
            sku
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PAGE_CREATE_MUTATION = `#graphql
  mutation pageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const REDIRECT_CREATE_MUTATION = `#graphql
  mutation urlRedirectCreate($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation collectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MENU_CREATE_MUTATION = `#graphql
  mutation menuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface RestoreResult {
  success: boolean;
  resourceType: ResourceType;
  resourceId: string;
  title: string;
  newResourceId?: string;
  error?: string;
}

/**
 * Map backed-up metafields ({ nodes: [{ namespace, key, value, type }] }) to
 * MetafieldInput. Skips entries that are never writable by this app and would
 * fail the WHOLE create mutation:
 * - entries missing a type (older backups didn't capture it)
 * - "shopify--*" and the plain "shopify" namespace (reserved; category
 *   metafields like shopify.color-pattern are only writable when the assigned
 *   category defines that attribute, which a restore can't guarantee)
 * - "app--<id>--*": other apps' reserved namespaces. The backup's metafields
 *   query captures PUBLIC_READ/MERCHANT_READ entries, but only the owning app
 *   can write them.
 * Reference-type metafields whose target no longer exists (e.g. a deleted
 * product's self-references) can't be detected here — the callers handle
 * those by retrying the create without metafields (see retry comments).
 */
function buildMetafieldInputs(
  data: Record<string, unknown>,
): Array<{ namespace: string; key: string; value: string; type: string }> {
  const metafields = data.metafields as
    | { nodes?: Array<{ namespace?: string; key?: string; value?: string; type?: string }> }
    | undefined;
  return (metafields?.nodes ?? [])
    .filter(
      (mf) =>
        mf.namespace &&
        mf.key &&
        mf.type &&
        mf.namespace !== "shopify" &&
        !mf.namespace.startsWith("shopify--") &&
        !mf.namespace.startsWith("app--"),
    )
    .map((mf) => ({
      namespace: mf.namespace as string,
      key: mf.key as string,
      value: mf.value ?? "",
      type: mf.type as string,
    }));
}

/**
 * Best-effort restore of metafields, one metafieldsSet call per entry, used
 * after an atomic create mutation had to be retried without its metafields.
 * Sending them individually means one unwritable entry (e.g. a reference to a
 * since-deleted resource) only loses itself. Failures are logged, never
 * thrown, and never fail the restore.
 */
async function setMetafieldsBestEffort(
  admin: AdminApiContext,
  ownerId: string,
  metafields: Array<{ namespace: string; key: string; value: string; type: string }>,
): Promise<void> {
  for (const mf of metafields) {
    try {
      const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
        variables: { metafields: [{ ownerId, ...mf }] },
      });
      const json = await response.json();
      const errors = json.data?.metafieldsSet?.userErrors;
      if (errors?.length) {
        console.warn(
          `[Restore] Skipped metafield ${mf.namespace}.${mf.key} on ${ownerId}: ${errors.map((e: { message: string }) => e.message).join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(
        `[Restore] Skipped metafield ${mf.namespace}.${mf.key} on ${ownerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function restoreProduct(
  admin: AdminApiContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = data.title as string;
  const resourceId = data.id as string;

  try {
    // Build product input from backup data.
    // Uses productSet (2026-04) which creates a product with all of its
    // options and variants in a single synchronous call. The identifier is
    // omitted so a brand-new product is created.
    const input: Record<string, unknown> = {
      title: data.title,
      descriptionHtml: data.descriptionHtml,
      productType: data.productType,
      vendor: data.vendor,
      tags: data.tags,
      status: "DRAFT", // Always restore as draft for safety
      templateSuffix: data.templateSuffix,
      handle: data.handle,
    };

    // SEO
    if (data.seo) {
      input.seo = data.seo;
    }

    // Category (taxonomy id). The "Uncategorized" placeholder (id ".../na") is
    // the "no category" sentinel and is NOT an assignable id, so skip it —
    // omitting category on a new product means uncategorized anyway.
    const categoryId = (data.category as { id?: string } | null | undefined)?.id;
    if (categoryId && !categoryId.endsWith("/na")) {
      input.category = categoryId;
    }

    // Metafields
    const metafields = buildMetafieldInputs(data);
    if (metafields.length) {
      input.metafields = metafields;
    }

    // Options
    const options = data.options as Array<{ name: string; position?: number; values: string[] }> | undefined;
    if (options?.length) {
      input.productOptions = options.map((opt) => ({
        name: opt.name,
        ...(opt.position ? { position: opt.position } : {}),
        values: opt.values.map((v) => ({ name: v })),
      }));
    }

    // Variants. Weight, requiresShipping and tracked live under inventoryItem
    // in 2026-04 (weight/weightUnit were removed from ProductVariant).
    const variants = data.variants as { nodes: Array<Record<string, unknown>> } | undefined;
    if (variants?.nodes?.length) {
      input.variants = variants.nodes.map((v) => {
        const inv = v.inventoryItem as
          | {
              tracked?: boolean;
              requiresShipping?: boolean;
              unitCost?: { amount?: unknown } | null;
              harmonizedSystemCode?: string | null;
              countryCodeOfOrigin?: string | null;
              measurement?: { weight?: { value: number; unit: string } };
            }
          | undefined;

        const inventoryItem: Record<string, unknown> = {};
        if (inv?.tracked !== undefined) inventoryItem.tracked = inv.tracked;
        if (inv?.requiresShipping !== undefined) inventoryItem.requiresShipping = inv.requiresShipping;
        // InventoryItemInput.cost is a Decimal — pass the backed-up amount as a string.
        if (inv?.unitCost?.amount != null) inventoryItem.cost = String(inv.unitCost.amount);
        if (inv?.harmonizedSystemCode != null) inventoryItem.harmonizedSystemCode = inv.harmonizedSystemCode;
        if (inv?.countryCodeOfOrigin != null) inventoryItem.countryCodeOfOrigin = inv.countryCodeOfOrigin;
        if (inv?.measurement?.weight) {
          inventoryItem.measurement = {
            weight: { value: inv.measurement.weight.value, unit: inv.measurement.weight.unit },
          };
        }

        return {
          sku: v.sku,
          barcode: v.barcode,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          taxable: v.taxable,
          ...(Object.keys(inventoryItem).length ? { inventoryItem } : {}),
          optionValues: (v.selectedOptions as Array<{ name: string; value: string }>)?.map((opt) => ({
            optionName: opt.name,
            name: opt.value,
          })),
        };
      });
    }

    // Images as files
    const images = data.images as { nodes: Array<{ url: string; altText?: string }> } | undefined;
    const files = images?.nodes?.map((img) => ({
      originalSource: img.url,
      alt: img.altText || "",
      contentType: "IMAGE" as const,
    }));
    if (files?.length) {
      input.files = files;
    }

    let response = await admin.graphql(PRODUCT_SET_MUTATION, {
      variables: { input },
    });
    let json = await response.json();
    let result = json.data?.productSet;

    // productSet is atomic: one unwritable metafield (e.g. a reference-type
    // metafield pointing at a since-deleted resource — guaranteed for a
    // deleted product's self-references) aborts the ENTIRE create. If the
    // first attempt failed and metafields were included, retry without them
    // so the product itself still restores (as it did before metafields were
    // added to the input), then best-effort set them individually below.
    let deferredMetafields: typeof metafields | null = null;
    if (result?.userErrors?.length && metafields.length) {
      delete input.metafields;
      deferredMetafields = metafields;
      response = await admin.graphql(PRODUCT_SET_MUTATION, {
        variables: { input },
      });
      json = await response.json();
      result = json.data?.productSet;
    }

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "PRODUCT",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    const newProductId = result?.product?.id;
    if (deferredMetafields?.length && newProductId) {
      await setMetafieldsBestEffort(admin, newProductId, deferredMetafields);
    }

    return {
      success: true,
      resourceType: "PRODUCT",
      resourceId,
      title,
      newResourceId: newProductId,
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "PRODUCT",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restorePage(
  admin: AdminApiContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = data.title as string;
  const resourceId = data.id as string;

  try {
    const response = await admin.graphql(PAGE_CREATE_MUTATION, {
      variables: {
        page: {
          title: data.title,
          handle: data.handle,
          body: data.body,
          isPublished: false, // Restore as unpublished for safety
        },
      },
    });
    const json = await response.json();
    const result = json.data?.pageCreate;

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "PAGE",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    return {
      success: true,
      resourceType: "PAGE",
      resourceId,
      title,
      newResourceId: result?.page?.id,
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "PAGE",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restoreRedirect(
  admin: AdminApiContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const resourceId = data.id as string;

  try {
    const response = await admin.graphql(REDIRECT_CREATE_MUTATION, {
      variables: {
        urlRedirect: {
          path: data.path,
          target: data.target,
        },
      },
    });
    const json = await response.json();
    const result = json.data?.urlRedirectCreate;

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "REDIRECT",
        resourceId,
        title: data.path as string,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    return {
      success: true,
      resourceType: "REDIRECT",
      resourceId,
      title: data.path as string,
      newResourceId: result?.urlRedirect?.id,
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "REDIRECT",
      resourceId,
      title: data.path as string,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restoreCollection(
  admin: AdminApiContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = data.title as string;
  const resourceId = data.id as string;

  try {
    const input: Record<string, unknown> = {
      title: data.title,
      handle: data.handle,
      descriptionHtml: data.descriptionHtml,
      sortOrder: data.sortOrder,
      templateSuffix: data.templateSuffix,
    };

    // Image
    const image = data.image as { url: string; altText?: string } | undefined;
    if (image?.url) {
      input.image = {
        src: image.url,
        altText: image.altText || "",
      };
    }

    // SEO
    if (data.seo) {
      input.seo = data.seo;
    }

    // Smart collection rule set
    const ruleSet = data.ruleSet as {
      appliedDisjunctively: boolean;
      rules: Array<{ column: string; relation: string; condition: string }>;
    } | null | undefined;

    if (ruleSet?.rules?.length) {
      input.ruleSet = {
        appliedDisjunctively: ruleSet.appliedDisjunctively,
        rules: ruleSet.rules.map((rule) => ({
          column: rule.column,
          relation: rule.relation,
          condition: rule.condition,
        })),
      };
    }

    // Metafields (same reserved-namespace/missing-type filtering as products)
    const metafields = buildMetafieldInputs(data);
    if (metafields.length) {
      input.metafields = metafields;
    }

    // Restore as unpublished - no publications
    // The collectionCreate mutation creates unpublished by default when no
    // publications are specified.

    let response = await admin.graphql(COLLECTION_CREATE_MUTATION, {
      variables: { input },
    });
    let json = await response.json();
    let result = json.data?.collectionCreate;

    // collectionCreate is atomic like productSet: one unwritable metafield
    // aborts the whole create. Retry without metafields, then best-effort set
    // them individually below (see restoreProduct for the rationale).
    let deferredMetafields: typeof metafields | null = null;
    if (result?.userErrors?.length && metafields.length) {
      delete input.metafields;
      deferredMetafields = metafields;
      response = await admin.graphql(COLLECTION_CREATE_MUTATION, {
        variables: { input },
      });
      json = await response.json();
      result = json.data?.collectionCreate;
    }

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "COLLECTION",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    const newCollectionId = result?.collection?.id;
    if (deferredMetafields?.length && newCollectionId) {
      await setMetafieldsBestEffort(admin, newCollectionId, deferredMetafields);
    }

    console.log(`[Restore] Collection "${title}" created${ruleSet?.rules?.length ? " (smart collection)" : " (custom collection)"}`);

    return {
      success: true,
      resourceType: "COLLECTION",
      resourceId,
      title,
      newResourceId: newCollectionId,
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "COLLECTION",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restoreBlogPost(
  rest: RestContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = data.title as string;
  const resourceId = data.id as string;

  try {
    // Blog posts (articles) require a blog to be associated with.
    // The backup data has blog: { id, title }.
    const blog = data.blog as { id: string; title: string } | undefined;

    if (!blog?.id) {
      return {
        success: false,
        resourceType: "BLOG_POST",
        resourceId,
        title,
        error: "Blog post has no associated blog - cannot restore without a blog",
      };
    }

    // Shopify's GraphQL Admin API does not have an articleCreate mutation
    // (as of 2025-01). We use the REST Admin API instead.
    const articleBody: Record<string, unknown> = {
      title: data.title,
      // `body` since API 2026-04; `contentHtml` in blobs written before that,
      // which must still restore.
      body_html: data.body ?? data.contentHtml,
      summary_html: data.summary || undefined,
      tags: Array.isArray(data.tags) ? (data.tags as string[]).join(", ") : data.tags,
      handle: data.handle,
      published: false, // Restore as draft for safety
    };

    // Image
    const image = data.image as { url: string; altText?: string } | undefined;
    if (image?.url) {
      articleBody.image = {
        src: image.url,
        alt: image.altText || "",
      };
    }

    // SEO via metafields_global
    const seo = data.seo as { title?: string; description?: string } | undefined;
    if (seo?.title) {
      articleBody.metafields_global_title_tag = seo.title;
    }
    if (seo?.description) {
      articleBody.metafields_global_description_tag = seo.description;
    }

    // Extract the numeric blog ID from the GID (e.g., "gid://shopify/Blog/123" -> "123")
    const blogNumericId = blog.id.split("/").pop();

    const responseBody = await shopifyRestRequest(
      rest,
      "POST",
      `blogs/${blogNumericId}/articles.json`,
      { article: articleBody },
    ) as { article?: { id: number; title: string } };

    if (!responseBody.article?.id) {
      return {
        success: false,
        resourceType: "BLOG_POST",
        resourceId,
        title,
        error: "REST API did not return a created article",
      };
    }

    console.log(`[Restore] Blog post "${title}" created in blog "${blog.title}" (REST API)`);

    return {
      success: true,
      resourceType: "BLOG_POST",
      resourceId,
      title,
      newResourceId: `gid://shopify/Article/${responseBody.article.id}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      resourceType: "BLOG_POST",
      resourceId,
      title,
      // The only REST call here is the article POST — a 403 means the
      // write_content scope hasn't been granted yet.
      error: message.includes("(403)")
        ? `${message} — creating blog articles requires the write_content scope; the merchant must re-approve the app's permissions before blog posts can be restored.`
        : message,
    };
  }
}

interface MenuItem {
  id?: string;
  title: string;
  type: string;
  url: string | null;
  items?: MenuItem[];
}

interface MenuItemCreateInput {
  title: string;
  type: string;
  url?: string;
  items?: MenuItemCreateInput[];
}

function buildMenuItemsInput(items: MenuItem[]): MenuItemCreateInput[] {
  return items.map((item) => {
    const menuItem: MenuItemCreateInput = {
      title: item.title,
      type: item.type,
      url: item.url || undefined,
    };

    // Recursively handle nested items
    if (item.items?.length) {
      menuItem.items = buildMenuItemsInput(item.items);
    }

    return menuItem;
  });
}

async function restoreMenu(
  admin: AdminApiContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = data.title as string;
  const resourceId = data.id as string;

  try {
    const items = data.items as MenuItem[] | undefined;
    const menuItems = items?.length ? buildMenuItemsInput(items) : [];

    const response = await admin.graphql(MENU_CREATE_MUTATION, {
      variables: {
        title: data.title as string,
        handle: data.handle as string,
        items: menuItems,
      },
    });
    const json = await response.json();
    const result = json.data?.menuCreate;

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "MENU",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    console.log(`[Restore] Menu "${title}" created with ${menuItems.length} top-level items`);

    return {
      success: true,
      resourceType: "MENU",
      resourceId,
      title,
      newResourceId: result?.menu?.id,
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "MENU",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function restoreTheme(
  rest: RestContext,
  data: Record<string, unknown>,
): Promise<RestoreResult> {
  const title = (data.name as string) || (data.title as string) || "Theme";
  const resourceId = data.id as string;

  // Writing theme assets requires the REST Asset API, which Shopify restricted
  // in 2023 (and the app has no write_themes scope), so the old PUT-based
  // restore failed 100% of the time. Fail fast with guidance instead of
  // calling the API — the backed-up theme files remain available via export.
  return {
    success: false,
    resourceType: "THEME",
    resourceId,
    title,
    error:
      "Theme restore is not supported: Shopify restricted the theme asset write API. Use the backup export to retrieve theme files.",
  };
}

/**
 * Restore specific items from a backup.
 *
 * @param admin - Shopify Admin GraphQL API context
 * @param shop - The authenticated shop domain. Item ids come from the client,
 *   so the query MUST be scoped to this shop's backups — otherwise any
 *   merchant could restore another store's backup data into their own shop.
 * @param backupItemIds - IDs of BackupItem records to restore
 * @param rest - Optional REST context (shop + accessToken) needed for
 *   BLOG_POST and THEME restores which require the REST Admin API.
 *   If not provided, those resource types will fail with an informative error.
 */
export async function restoreItems(
  admin: AdminApiContext,
  shop: string,
  backupItemIds: string[],
  rest?: RestContext,
): Promise<RestoreResult[]> {
  const items = await prisma.backupItem.findMany({
    where: { id: { in: backupItemIds }, backup: { storeId: shop } },
  });

  const results: RestoreResult[] = [];

  for (const item of items) {
    const raw = await storage.get(item.storagePath);
    if (!raw) {
      results.push({
        success: false,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        title: item.title || item.resourceId,
        error: "Backup data not found in storage",
      });
      continue;
    }

    const data = JSON.parse(raw);

    switch (item.resourceType) {
      case "PRODUCT":
        results.push(await restoreProduct(admin, data));
        break;
      case "PAGE":
        results.push(await restorePage(admin, data));
        break;
      case "REDIRECT":
        results.push(await restoreRedirect(admin, data));
        break;
      case "COLLECTION":
        results.push(await restoreCollection(admin, data));
        break;
      case "BLOG_POST":
        if (!rest) {
          results.push({
            success: false,
            resourceType: "BLOG_POST",
            resourceId: item.resourceId,
            title: item.title || item.resourceId,
            error: "Blog post restore requires REST API context (shop and accessToken)",
          });
        } else {
          results.push(await restoreBlogPost(rest, data));
        }
        break;
      case "MENU":
        results.push(await restoreMenu(admin, data));
        break;
      case "THEME":
        if (!rest) {
          results.push({
            success: false,
            resourceType: "THEME",
            resourceId: item.resourceId,
            title: item.title || item.resourceId,
            error: "Theme restore requires REST API context (shop and accessToken)",
          });
        } else {
          results.push(await restoreTheme(rest, data));
        }
        break;
      default:
        results.push({
          success: false,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          title: item.title || item.resourceId,
          error: `Restore not yet implemented for ${item.resourceType}`,
        });
    }
  }

  return results;
}

/**
 * Restore an entire backup.
 *
 * @param admin - Shopify Admin GraphQL API context
 * @param shop - The authenticated shop domain; the backup must belong to it
 * @param backupId - The backup to restore from
 * @param resourceTypes - Optional filter to only restore certain resource types
 * @param rest - Optional REST context needed for BLOG_POST and THEME restores
 */
export async function restoreBackup(
  admin: AdminApiContext,
  shop: string,
  backupId: string,
  resourceTypes?: ResourceType[],
  rest?: RestContext,
): Promise<RestoreResult[]> {
  const where: Record<string, unknown> = {
    backupId,
    backup: { storeId: shop },
  };
  if (resourceTypes?.length) {
    where.resourceType = { in: resourceTypes };
  }

  const items = await prisma.backupItem.findMany({ where });
  return restoreItems(admin, shop, items.map((i) => i.id), rest);
}
