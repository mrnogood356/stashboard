import { Injectable, Logger } from '@nestjs/common';
import { SceneLifecycle } from '@prisma/client';
import { OrganizerService } from '../organizer/organizer.service';
import { LocalLibraryService } from '../playback/local-library.service';
import { PrismaService } from '../prisma/prisma.service';
import { HomeAttentionDto } from './dto/home-attention.dto';

/** Cheap counts of what needs the user, for the "Needs you" card on Home. */
@Injectable()
export class HomeAttentionService {
  private readonly logger = new Logger(HomeAttentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizer: OrganizerService,
    private readonly library: LocalLibraryService,
  ) {}

  async getAttention(): Promise<HomeAttentionDto> {
    const [matchesToCheck, lifecycle, unmatched] = await Promise.all([
      this.soft('matches to check', () => this.matchesToCheck()),
      this.soft('downloads', () => this.lifecycleCounts()),
      this.soft('unmatched scenes', () =>
        this.library.fixCounts().then((counts) => counts.unmatched),
      ),
    ]);
    return {
      matchesToCheck,
      failed: lifecycle?.failed ?? null,
      waitingForImport: lifecycle?.waitingForImport ?? null,
      unmatched,
    };
  }

  private matchesToCheck(): Promise<number> {
    return this.organizer.proposalCount();
  }

  private async lifecycleCounts(): Promise<{
    failed: number;
    waitingForImport: number;
  }> {
    const groups = await this.prisma.sceneIndex.groupBy({
      by: ['computedLifecycle'],
      where: {
        computedLifecycle: {
          in: [SceneLifecycle.FAILED, SceneLifecycle.IMPORT_PENDING],
        },
      },
      _count: { _all: true },
    });
    const count = (lifecycle: SceneLifecycle): number =>
      groups.find((group) => group.computedLifecycle === lifecycle)?._count
        ._all ?? 0;
    return {
      failed: count(SceneLifecycle.FAILED),
      waitingForImport: count(SceneLifecycle.IMPORT_PENDING),
    };
  }

  private async soft<T>(
    label: string,
    load: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      this.logger.warn(
        `Could not count ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
