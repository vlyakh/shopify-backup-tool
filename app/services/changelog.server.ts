import prisma from "../db.server";
import { storage } from "./storage.server";
import type { ResourceType, ChangeAction } from "@prisma/client";

/**
 * Record a change from a webhook event.
 * Stores before/after snapshots and identifies changed fields.
 */
export async function recordChange(
  storeId: string,
  resourceType: ResourceType,
  resourceId: string,
  action: ChangeAction,
  data: unknown,
): Promise<string | null> {
  // Check if store has premium plan with webhooks enabled
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store?.webhooksEnabled) return null;

  const timestamp = Date.now();
  const afterPath = `${storeId}/changes/${resourceType}/${encodeURIComponent(resourceId)}/${timestamp}-after.json`;

  // Store the current state
  await storage.put(afterPath, JSON.stringify(data, null, 2));

  // Find the previous state (from last backup or last change)
  let beforePath: string | null = null;
  const changedFields: string[] = [];

  if (action === "UPDATED") {
    // Look for the most recent snapshot of this resource
    const lastChange = await prisma.changeLog.findFirst({
      where: { storeId, resourceType, resourceId },
      orderBy: { changedAt: "desc" },
    });

    if (lastChange?.afterPath) {
      beforePath = lastChange.afterPath;

      // Compute changed fields by comparing before/after
      const beforeData = await storage.get(beforePath);
      if (beforeData) {
        const before = JSON.parse(beforeData);
        const after = data as Record<string, unknown>;
        computeChangedFields(before, after, "", changedFields);
      }
    }
  }

  const created = await prisma.changeLog.create({
    data: {
      storeId,
      resourceType,
      resourceId,
      action,
      beforePath,
      afterPath,
      changedFields,
    },
  });
  return created.id;
}

/**
 * Shallow comparison of two objects to find changed top-level fields.
 */
function computeChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  result: string[],
): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const beforeVal = before[key];
    const afterVal = after[key];

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      result.push(fullKey);
    }
  }
}

/**
 * Get change history for a resource.
 */
export async function getChangeHistory(
  storeId: string,
  resourceType?: ResourceType,
  resourceId?: string,
  limit = 50,
) {
  const where: Record<string, unknown> = { storeId };
  if (resourceType) where.resourceType = resourceType;
  if (resourceId) where.resourceId = resourceId;

  return prisma.changeLog.findMany({
    where,
    orderBy: { changedAt: "desc" },
    take: limit,
  });
}

/**
 * Get the before/after diff for a specific change.
 */
export async function getChangeDiff(changeId: string) {
  const change = await prisma.changeLog.findUnique({ where: { id: changeId } });
  if (!change) return null;

  const before = change.beforePath ? await storage.get(change.beforePath) : null;
  const after = change.afterPath ? await storage.get(change.afterPath) : null;

  return {
    change,
    before: before ? JSON.parse(before) : null,
    after: after ? JSON.parse(after) : null,
  };
}
