import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { storage } from "../services/storage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[Webhook] ${topic} for ${shop}`);

  // Shop data erasure request - delete all data for this shop
  // Delete backups and their storage
  const backups = await prisma.backup.findMany({
    where: { storeId: shop },
    select: { id: true },
  });

  for (const backup of backups) {
    await storage.deletePrefix(`${shop}/${backup.id}/`);
  }

  // Delete change logs storage
  await storage.deletePrefix(`${shop}/changes/`);

  // Delete all database records
  await prisma.changeLog.deleteMany({ where: { storeId: shop } });
  await prisma.backupItem.deleteMany({
    where: { backup: { storeId: shop } },
  });
  await prisma.backup.deleteMany({ where: { storeId: shop } });
  await prisma.backupSchedule.deleteMany({ where: { storeId: shop } });
  await prisma.store.deleteMany({ where: { id: shop } });

  return new Response(null, { status: 200 });
};
