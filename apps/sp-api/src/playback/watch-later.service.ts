import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  LocalLibraryService,
  type LocalSceneCardDto,
} from './local-library.service';

const MAX_ITEMS = 500;

export interface WatchLaterDto {
  items: LocalSceneCardDto[];
}

/** Scenes saved to watch later, in your order. Played to the end, one leaves the list. */
@Injectable()
export class WatchLaterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly library: LocalLibraryService,
  ) {}

  async ids(): Promise<string[]> {
    const rows = await this.prisma.watchLaterItem.findMany({
      orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
      select: { stashSceneId: true },
    });
    return rows.map((row) => row.stashSceneId);
  }

  async list(): Promise<WatchLaterDto> {
    const ids = await this.ids();
    const items = await this.library.cardsFor(ids);
    // Scenes gone from Stash leave the list.
    const kept = new Set(items.map((item) => item.id));
    const gone = ids.filter((id) => !kept.has(id));
    if (gone.length > 0 && items.length > 0) {
      await this.prisma.watchLaterItem.deleteMany({
        where: { stashSceneId: { in: gone } },
      });
    }
    return { items };
  }

  async add(stashSceneId: string): Promise<string[]> {
    const id = sceneIdOf(stashSceneId);
    const count = await this.prisma.watchLaterItem.count();
    if (count >= MAX_ITEMS) {
      throw new BadRequestException(
        `Watch later holds up to ${MAX_ITEMS} scenes.`,
      );
    }
    const last = await this.prisma.watchLaterItem.findFirst({
      orderBy: { position: 'desc' },
    });
    await this.prisma.watchLaterItem.upsert({
      where: { stashSceneId: id },
      create: { stashSceneId: id, position: (last?.position ?? -1) + 1 },
      update: {},
    });
    return this.ids();
  }

  async remove(stashSceneId: string): Promise<string[]> {
    await this.prisma.watchLaterItem.deleteMany({
      where: { stashSceneId: sceneIdOf(stashSceneId) },
    });
    return this.ids();
  }

  /** Puts the list in this order; ids not on the list are ignored, ones left out go last. */
  async reorder(order: string[]): Promise<string[]> {
    const current = await this.ids();
    const onList = new Set(current);
    const first = [...new Set(order)].filter((id) => onList.has(id));
    const rest = current.filter((id) => !first.includes(id));
    const next = [...first, ...rest];
    await this.prisma.$transaction(
      next.map((id, position) =>
        this.prisma.watchLaterItem.update({
          where: { stashSceneId: id },
          data: { position },
        }),
      ),
    );
    return next;
  }

  async clear(): Promise<string[]> {
    await this.prisma.watchLaterItem.deleteMany({});
    return [];
  }
}

function sceneIdOf(value: string): string {
  const id = value.trim();
  if (!/^\d{1,12}$/.test(id)) {
    throw new BadRequestException('That isn’t a Stash scene id.');
  }
  return id;
}
