import type { PrismaService } from '../prisma/prisma.service';

/** This catalog scene and the ids Stashboard counts as the same one (merged scenes). */
export async function sameSceneIds(
  prisma: PrismaService,
  stashId: string,
): Promise<string[]> {
  const aliases = await prisma.sceneStashAlias
    .findMany({ where: { OR: [{ stashId }, { aliasOf: stashId }] } })
    .catch(() => [] as Array<{ stashId: string; aliasOf: string }>);
  return [
    ...new Set([
      stashId,
      ...aliases.flatMap((alias) => [alias.stashId, alias.aliasOf]),
    ]),
  ];
}
