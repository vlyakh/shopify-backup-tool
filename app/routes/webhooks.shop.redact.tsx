import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Shop data erasure request - delete ALL data for this shop.
  // Every blob lives under `${shop}/` (backups, changes/, state/), so one
  // prefix delete erases the lot.
  await storage.deletePrefix(`${shop}/`);

  // Delete all database records
  await prisma.changeLog.deleteMany({ where: { storeId: shop } });
  await prisma.webhookEvent.deleteMany({ where: { storeId: shop } });
  await prisma.revertSuppression.deleteMany({ where: { storeId: shop } });
  await prisma.backupItem.deleteMany({
    where: { backup: { storeId: shop } },
  });
  await prisma.backup.deleteMany({ where: { storeId: shop } });
  await prisma.backupSchedule.deleteMany({ where: { storeId: shop } });
  await prisma.store.deleteMany({ where: { id: shop } });

  return new Response(null, { status: 200 });
};
