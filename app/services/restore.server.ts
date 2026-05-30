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

interface RestoreResult {
  success: boolean;
  resourceType: ResourceType;
  resourceId: string;
  title: string;
  newResourceId?: string;
  error?: string;
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
          | { tracked?: boolean; requiresShipping?: boolean; measurement?: { weight?: { value: number; unit: string } } }
          | undefined;

        const inventoryItem: Record<string, unknown> = {};
        if (inv?.tracked !== undefined) inventoryItem.tracked = inv.tracked;
        if (inv?.requiresShipping !== undefined) inventoryItem.requiresShipping = inv.requiresShipping;
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

    const response = await admin.graphql(PRODUCT_SET_MUTATION, {
      variables: { input },
    });
    const json = await response.json();
    const result = json.data?.productSet;

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "PRODUCT",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    return {
      success: true,
      resourceType: "PRODUCT",
      resourceId,
      title,
      newResourceId: result?.product?.id,
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

    // Restore as unpublished - no publications
    // The collectionCreate mutation creates unpublished by default when no
    // publications are specified.

    const response = await admin.graphql(COLLECTION_CREATE_MUTATION, {
      variables: { input },
    });
    const json = await response.json();
    const result = json.data?.collectionCreate;

    if (result?.userErrors?.length) {
      return {
        success: false,
        resourceType: "COLLECTION",
        resourceId,
        title,
        error: result.userErrors.map((e: { message: string }) => e.message).join(", "),
      };
    }

    console.log(`[Restore] Collection "${title}" created${ruleSet?.rules?.length ? " (smart collection)" : " (custom collection)"}`);

    return {
      success: true,
      resourceType: "COLLECTION",
      resourceId,
      title,
      newResourceId: result?.collection?.id,
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
      body_html: data.contentHtml,
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
    return {
      success: false,
      resourceType: "BLOG_POST",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
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

  try {
    // Theme restore focuses on settings files (settings_data.json, etc.)
    // via the REST Asset API. We write theme asset files back to a target theme.
    //
    // The backup data should contain:
    //   - id: the theme GID or numeric ID
    //   - name/title: theme name
    //   - assets: array of { key, value } representing theme files

    const assets = data.assets as Array<{ key: string; value?: string; attachment?: string }> | undefined;

    if (!assets?.length) {
      return {
        success: false,
        resourceType: "THEME",
        resourceId,
        title,
        error: "No theme assets found in backup data",
      };
    }

    // Extract numeric theme ID from GID if needed
    const themeNumericId = resourceId.includes("/")
      ? resourceId.split("/").pop()
      : resourceId;

    // Verify the theme still exists before writing assets to it.
    // Themes cannot be created via the API, so if it's gone we must inform the user.
    let themeExists = false;
    try {
      const themeBody = await shopifyRestRequest(
        rest,
        "GET",
        `themes/${themeNumericId}.json`,
      ) as { theme?: { id: number } };
      themeExists = !!themeBody.theme?.id;
    } catch {
      themeExists = false;
    }

    if (!themeExists) {
      return {
        success: false,
        resourceType: "THEME",
        resourceId,
        title,
        error: `Theme ${themeNumericId} no longer exists. Theme assets can only be restored to an existing theme. Create a theme first, then restore assets to it.`,
      };
    }

    // Restore each asset via the REST Asset API
    const errors: string[] = [];
    let restoredCount = 0;

    for (const asset of assets) {
      try {
        const assetData: Record<string, string> = { key: asset.key };

        // Assets can be text (value) or binary (attachment as base64)
        if (asset.value !== undefined) {
          assetData.value = asset.value;
        } else if (asset.attachment !== undefined) {
          assetData.attachment = asset.attachment;
        } else {
          continue; // Skip assets with no content
        }

        await shopifyRestRequest(
          rest,
          "PUT",
          `themes/${themeNumericId}/assets.json`,
          { asset: assetData },
        );
        restoredCount++;
      } catch (assetError) {
        const message = assetError instanceof Error ? assetError.message : String(assetError);
        errors.push(`${asset.key}: ${message}`);
      }
    }

    if (errors.length > 0 && restoredCount === 0) {
      return {
        success: false,
        resourceType: "THEME",
        resourceId,
        title,
        error: `All asset restores failed. First error: ${errors[0]}`,
      };
    }

    console.log(`[Restore] Theme "${title}" - restored ${restoredCount}/${assets.length} assets${errors.length > 0 ? ` (${errors.length} failed)` : ""}`);

    return {
      success: true,
      resourceType: "THEME",
      resourceId,
      title,
      newResourceId: resourceId,
      ...(errors.length > 0 ? { error: `Partially restored: ${errors.length} asset(s) failed` } : {}),
    };
  } catch (error) {
    return {
      success: false,
      resourceType: "THEME",
      resourceId,
      title,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Restore specific items from a backup.
 *
 * @param admin - Shopify Admin GraphQL API context
 * @param backupItemIds - IDs of BackupItem records to restore
 * @param rest - Optional REST context (shop + accessToken) needed for
 *   BLOG_POST and THEME restores which require the REST Admin API.
 *   If not provided, those resource types will fail with an informative error.
 */
export async function restoreItems(
  admin: AdminApiContext,
  backupItemIds: string[],
  rest?: RestContext,
): Promise<RestoreResult[]> {
  const items = await prisma.backupItem.findMany({
    where: { id: { in: backupItemIds } },
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
 * @param backupId - The backup to restore from
 * @param resourceTypes - Optional filter to only restore certain resource types
 * @param rest - Optional REST context needed for BLOG_POST and THEME restores
 */
export async function restoreBackup(
  admin: AdminApiContext,
  backupId: string,
  resourceTypes?: ResourceType[],
  rest?: RestContext,
): Promise<RestoreResult[]> {
  const where: Record<string, unknown> = { backupId };
  if (resourceTypes?.length) {
    where.resourceType = { in: resourceTypes };
  }

  const items = await prisma.backupItem.findMany({ where });
  return restoreItems(admin, items.map((i) => i.id), rest);
}
