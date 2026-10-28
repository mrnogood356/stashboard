import { BadGatewayException, NotFoundException } from '@nestjs/common';
import {
  type StashdbAdapterBaseConfig,
  type StashdbFavoriteResult,
  type StashdbGraphqlResponse,
  type StashdbPerformerDetails,
  type StashdbPerformerFeedConfig,
  type StashdbPerformerFeedItem,
  type StashdbPerformerGender,
  type StashdbPerformersFeedResult,
  type StashdbStudioChildSummary,
  type StashdbStudioDetails,
  type StashdbStudioFeedItem,
  type StashdbStudioOption,
  type StashdbStudioParentSummary,
  type StashdbStudioUrl,
  type StashdbStudiosFeedConfig,
  type StashdbStudiosFeedResult,
} from './stashdb.types';
import { estimatedTotal, StashdbGraphqlClient } from './stashdb-graphql.client';

/** Performers and studios: feeds, details, search and favorites. */
export abstract class StashdbPeopleApi extends StashdbGraphqlClient {
  async getPerformersFeed(
    config: StashdbPerformerFeedConfig,
  ): Promise<StashdbPerformersFeedResult> {
    const normalizedName = config.name?.trim() ?? '';
    const sort = config.sort ?? 'NAME';
    const direction = config.direction ?? 'ASC';
    const inputParts = [
      'per_page: $perPage',
      'page: $page',
      `sort: ${sort}`,
      `direction: ${direction}`,
    ];

    if (normalizedName) {
      inputParts.push('name: $name');
    }

    if (config.gender) {
      inputParts.push(`gender: ${config.gender}`);
    }

    if (config.favoritesOnly) {
      inputParts.push('is_favorite: true');
    }

    const nameVariableDeclaration = normalizedName ? ', $name: String!' : '';
    const query = `
      query QueryPerformers($page: Int!, $perPage: Int!${nameVariableDeclaration}) {
        queryPerformers(input: { ${inputParts.join(', ')} }) {
          count
          performers {
            id
            name
            gender
            scene_count
            is_favorite
            images {
              id
              url
              width
              height
            }
          }
        }
      }
    `;

    const variables: Record<string, unknown> = {
      page: config.page,
      perPage: config.perPage,
    };
    if (normalizedName) {
      variables.name = normalizedName;
    }

    const payload = normalizedName
      ? await this.executeCountedSearch(config, query, variables)
      : await this.executeQuery(config, query, variables);
    const rawPerformers = payload.data?.queryPerformers?.performers ?? [];
    const total =
      typeof payload.data?.queryPerformers?.count === 'number'
        ? payload.data.queryPerformers.count
        : estimatedTotal(config.page, config.perPage, rawPerformers.length);

    const performers = rawPerformers
      .map((performer): StashdbPerformerFeedItem | null => {
        if (
          typeof performer.id !== 'string' ||
          typeof performer.name !== 'string'
        ) {
          return null;
        }

        return {
          id: performer.id,
          name: performer.name,
          gender: this.normalizePerformerGender(performer.gender),
          sceneCount:
            typeof performer.scene_count === 'number'
              ? performer.scene_count
              : 0,
          isFavorite: performer.is_favorite === true,
          imageUrl:
            this.selectPrimaryImage(this.normalizeImages(performer.images))
              ?.url ?? null,
        };
      })
      .filter(
        (performer): performer is StashdbPerformerFeedItem =>
          performer !== null,
      );

    return {
      total,
      performers,
    };
  }

  async getStudiosFeed(
    config: StashdbStudiosFeedConfig,
  ): Promise<StashdbStudiosFeedResult> {
    const normalizedName = config.name?.trim() ?? '';
    const sort = config.sort ?? 'NAME';
    const direction = config.direction;
    const inputParts = ['per_page: $perPage', 'page: $page', `sort: ${sort}`];

    if (direction) {
      inputParts.push(`direction: ${direction}`);
    }

    if (normalizedName) {
      inputParts.push('name: $name');
    }

    if (config.favoritesOnly) {
      inputParts.push('is_favorite: true');
    }

    const nameVariableDeclaration = normalizedName ? ', $name: String!' : '';
    const query = `
      query QueryStudios($page: Int!, $perPage: Int!${nameVariableDeclaration}) {
        queryStudios(input: { ${inputParts.join(', ')} }) {
          count
          studios {
            id
            name
            is_favorite
            images {
              id
              url
              width
              height
            }
            parent {
              id
              name
            }
            child_studios {
              id
              name
            }
          }
        }
      }
    `;

    const variables: Record<string, unknown> = {
      page: config.page,
      perPage: config.perPage,
    };
    if (normalizedName) {
      variables.name = normalizedName;
    }

    const payload = normalizedName
      ? await this.executeCountedSearch(config, query, variables)
      : await this.executeQuery(config, query, variables);
    const rawStudios = payload.data?.queryStudios?.studios ?? [];
    const total =
      typeof payload.data?.queryStudios?.count === 'number'
        ? payload.data.queryStudios.count
        : estimatedTotal(config.page, config.perPage, rawStudios.length);

    const studios = rawStudios
      .map((studio): StashdbStudioFeedItem | null => {
        if (typeof studio.id !== 'string' || typeof studio.name !== 'string') {
          return null;
        }

        const childStudios = (studio.child_studios ?? [])
          .map((child): { id: string; name: string } | null => {
            if (
              typeof child.id !== 'string' ||
              typeof child.name !== 'string'
            ) {
              return null;
            }

            return {
              id: child.id,
              name: child.name,
            };
          })
          .filter(
            (child): child is { id: string; name: string } => child !== null,
          );

        return {
          id: studio.id,
          name: studio.name,
          isFavorite: studio.is_favorite === true,
          imageUrl:
            this.selectPrimaryImage(this.normalizeImages(studio.images))?.url ??
            null,
          parentStudio:
            typeof studio.parent?.id === 'string' &&
            typeof studio.parent?.name === 'string'
              ? {
                  id: studio.parent.id,
                  name: studio.parent.name,
                }
              : null,
          childStudios,
        };
      })
      .filter((studio): studio is StashdbStudioFeedItem => studio !== null);

    return {
      total,
      studios,
    };
  }

  async getPerformerById(
    performerId: string,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbPerformerDetails> {
    const query = `
      query FindPerformer($id: ID!) {
        findPerformer(id: $id) {
          id
          name
          disambiguation
          aliases
          gender
          birth_date
          death_date
          age
          ethnicity
          country
          eye_color
          hair_color
          height
          cup_size
          band_size
          waist_size
          hip_size
          breast_type
          career_start_year
          career_end_year
          deleted
          merged_ids
          merged_into_id
          is_favorite
          created
          updated
          images {
            id
            url
            width
            height
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, { id: performerId });
    const performer = payload.data?.findPerformer;

    if (!performer) {
      throw new NotFoundException(
        `Performer ${performerId} not found in StashDB.`,
      );
    }

    if (
      typeof performer.id !== 'string' ||
      typeof performer.name !== 'string'
    ) {
      throw new BadGatewayException(
        'StashDB performer response is missing required fields.',
      );
    }

    const images = this.normalizeImages(performer.images);
    const primaryImage = this.selectPrimaryImage(images);

    return {
      id: performer.id,
      name: performer.name,
      disambiguation: this.normalizeOptionalString(performer.disambiguation),
      aliases: Array.isArray(performer.aliases)
        ? performer.aliases.filter(
            (alias): alias is string => typeof alias === 'string',
          )
        : [],
      gender: this.normalizePerformerGender(performer.gender),
      birthDate: this.normalizeOptionalString(performer.birth_date),
      deathDate: this.normalizeOptionalString(performer.death_date),
      age: typeof performer.age === 'number' ? performer.age : null,
      ethnicity: this.normalizeOptionalString(performer.ethnicity),
      country: this.normalizeOptionalString(performer.country),
      eyeColor: this.normalizeOptionalString(performer.eye_color),
      hairColor: this.normalizeOptionalString(performer.hair_color),
      height: this.normalizeOptionalString(performer.height),
      cupSize: this.normalizeOptionalString(performer.cup_size),
      bandSize:
        typeof performer.band_size === 'number' ? performer.band_size : null,
      waistSize:
        typeof performer.waist_size === 'number' ? performer.waist_size : null,
      hipSize:
        typeof performer.hip_size === 'number' ? performer.hip_size : null,
      breastType: this.normalizeOptionalString(performer.breast_type),
      careerStartYear:
        typeof performer.career_start_year === 'number'
          ? performer.career_start_year
          : null,
      careerEndYear:
        typeof performer.career_end_year === 'number'
          ? performer.career_end_year
          : null,
      deleted: performer.deleted === true,
      mergedIds: Array.isArray(performer.merged_ids)
        ? performer.merged_ids.filter(
            (mergedId): mergedId is string => typeof mergedId === 'string',
          )
        : [],
      mergedIntoId:
        typeof performer.merged_into_id === 'string'
          ? performer.merged_into_id
          : null,
      isFavorite: performer.is_favorite === true,
      createdAt: this.normalizeOptionalString(performer.created),
      updatedAt: this.normalizeOptionalString(performer.updated),
      imageUrl: primaryImage?.url ?? null,
      images,
    };
  }

  async getStudioById(
    studioId: string,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbStudioDetails> {
    const query = `
      query FindStudio($id: ID!) {
        findStudio(id: $id) {
          id
          name
          aliases
          deleted
          is_favorite
          created
          updated
          urls {
            url
            type
            site {
              name
              url
              icon
            }
          }
          parent {
            id
            name
            aliases
            is_favorite
            urls {
              url
              type
              site {
                name
                url
                icon
              }
            }
          }
          child_studios {
            id
            name
            aliases
            deleted
            is_favorite
            created
            updated
            urls {
              url
              type
              site {
                name
                url
                icon
              }
            }
            images {
              id
              url
              width
              height
            }
          }
          images {
            id
            url
            width
            height
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, { id: studioId });
    const studio = payload.data?.findStudio;

    if (!studio) {
      throw new NotFoundException(`Studio ${studioId} not found in StashDB.`);
    }

    if (typeof studio.id !== 'string' || typeof studio.name !== 'string') {
      throw new BadGatewayException(
        'StashDB studio response is missing required fields.',
      );
    }

    const images = this.normalizeImages(studio.images);
    const primaryImage = this.selectPrimaryImage(images);

    return {
      id: studio.id,
      name: studio.name,
      aliases: this.normalizeStringArray(studio.aliases),
      deleted: studio.deleted === true,
      isFavorite: studio.is_favorite === true,
      createdAt: this.normalizeOptionalString(studio.created),
      updatedAt: this.normalizeOptionalString(studio.updated),
      imageUrl: primaryImage?.url ?? null,
      images,
      urls: this.normalizeStudioUrls(studio.urls),
      parentStudio: this.normalizeStudioParent(studio.parent),
      childStudios: (studio.child_studios ?? [])
        .map((child): StashdbStudioChildSummary | null => {
          if (typeof child.id !== 'string' || typeof child.name !== 'string') {
            return null;
          }

          return {
            id: child.id,
            name: child.name,
            aliases: this.normalizeStringArray(child.aliases),
            deleted: child.deleted === true,
            isFavorite: child.is_favorite === true,
            createdAt: this.normalizeOptionalString(child.created),
            updatedAt: this.normalizeOptionalString(child.updated),
            imageUrl:
              this.selectPrimaryImage(this.normalizeImages(child.images))
                ?.url ?? null,
          };
        })
        .filter((child): child is StashdbStudioChildSummary => child !== null),
    };
  }

  async searchStudios(
    queryText: string,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbStudioOption[]> {
    const query = `
      query QueryStudios($name: String!) {
        queryStudios(input: { name: $name }) {
          studios {
            name
            id
            child_studios {
              id
              name
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, { name: queryText });
    const rawStudios = payload.data?.queryStudios?.studios ?? [];

    return rawStudios
      .map((studio): StashdbStudioOption | null => {
        if (typeof studio.id !== 'string' || typeof studio.name !== 'string') {
          return null;
        }

        const childStudios = (studio.child_studios ?? [])
          .map((child): { id: string; name: string } | null => {
            if (
              typeof child.id !== 'string' ||
              typeof child.name !== 'string'
            ) {
              return null;
            }

            return {
              id: child.id,
              name: child.name,
            };
          })
          .filter(
            (child): child is { id: string; name: string } => child !== null,
          );

        return {
          id: studio.id,
          name: studio.name,
          childStudios,
        };
      })
      .filter((studio): studio is StashdbStudioOption => studio !== null);
  }

  async favoritePerformer(
    performerId: string,
    favorite: boolean,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbFavoriteResult> {
    const query = `
      mutation FavoritePerformer($id: ID!) {
        favoritePerformer(id: $id, favorite: ${favorite ? 'true' : 'false'})
      }
    `;

    const payload = await this.executeQueryRaw(config, query, {
      id: performerId,
    });
    try {
      const result = this.normalizeFavoriteMutationResult(
        payload,
        'favoritePerformer',
        'performer_favorites_unique_idx',
        favorite,
      );
      await this.reportRuntimeSuccess();
      return result;
    } catch (error) {
      await this.reportRuntimeFailure(error);
      throw error;
    }
  }

  async favoriteStudio(
    studioId: string,
    favorite: boolean,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbFavoriteResult> {
    const query = `
      mutation FavoriteStudio($id: ID!) {
        favoriteStudio(id: $id, favorite: ${favorite ? 'true' : 'false'})
      }
    `;

    const payload = await this.executeQueryRaw(config, query, { id: studioId });
    try {
      const result = this.normalizeFavoriteMutationResult(
        payload,
        'favoriteStudio',
        'studio_favorites_unique_idx',
        favorite,
      );
      await this.reportRuntimeSuccess();
      return result;
    } catch (error) {
      await this.reportRuntimeFailure(error);
      throw error;
    }
  }

  protected normalizePerformerGender(
    value: unknown,
  ): StashdbPerformerGender | null {
    if (
      value === 'MALE' ||
      value === 'FEMALE' ||
      value === 'UNKNOWN' ||
      value === 'TRANSGENDER_MALE' ||
      value === 'TRANSGENDER_FEMALE' ||
      value === 'INTERSEX' ||
      value === 'NON_BINARY'
    ) {
      return value;
    }

    return null;
  }

  protected normalizeStudioUrls(
    rawUrls:
      | Array<{
          url?: unknown;
          type?: unknown;
          site?: {
            name?: unknown;
            url?: unknown;
            icon?: unknown;
          } | null;
        }>
      | null
      | undefined,
  ): StashdbStudioUrl[] {
    return (rawUrls ?? [])
      .map((rawUrl): StashdbStudioUrl | null => {
        if (typeof rawUrl.url !== 'string') {
          return null;
        }

        return {
          url: rawUrl.url,
          type: this.normalizeOptionalString(rawUrl.type),
          siteName: this.normalizeOptionalString(rawUrl.site?.name),
          siteUrl: this.normalizeOptionalString(rawUrl.site?.url),
          siteIcon: this.normalizeOptionalString(rawUrl.site?.icon),
        };
      })
      .filter((url): url is StashdbStudioUrl => url !== null);
  }

  protected normalizeStudioParent(
    rawParent:
      | {
          id?: unknown;
          name?: unknown;
          aliases?: unknown;
          is_favorite?: unknown;
          urls?: Array<{
            url?: unknown;
            type?: unknown;
            site?: {
              name?: unknown;
              url?: unknown;
              icon?: unknown;
            } | null;
          }>;
        }
      | null
      | undefined,
  ): StashdbStudioParentSummary | null {
    if (!rawParent) {
      return null;
    }

    if (
      typeof rawParent.id !== 'string' ||
      typeof rawParent.name !== 'string'
    ) {
      return null;
    }

    return {
      id: rawParent.id,
      name: rawParent.name,
      aliases: this.normalizeStringArray(rawParent.aliases),
      isFavorite: rawParent.is_favorite === true,
      urls: this.normalizeStudioUrls(rawParent.urls),
    };
  }

  protected normalizeFavoriteMutationResult(
    payload: StashdbGraphqlResponse,
    mutationField: 'favoritePerformer' | 'favoriteStudio',
    duplicateConstraint: string,
    requestedFavorite: boolean,
  ): StashdbFavoriteResult {
    if (typeof payload.data?.[mutationField] === 'boolean') {
      return {
        favorited: requestedFavorite,
        alreadyFavorited: false,
      };
    }

    if (
      requestedFavorite &&
      payload.errors?.some((error) =>
        this.isDuplicateFavoriteError(
          error,
          mutationField,
          duplicateConstraint,
        ),
      )
    ) {
      return {
        favorited: true,
        alreadyFavorited: true,
      };
    }

    if (payload.errors && payload.errors.length > 0) {
      const firstError = payload.errors[0]?.message;
      const message =
        typeof firstError === 'string' && firstError.length > 0
          ? firstError
          : 'StashDB favorite mutation failed.';
      throw new BadGatewayException(message);
    }

    throw new BadGatewayException(
      'StashDB favorite mutation returned an invalid response.',
    );
  }

  protected isDuplicateFavoriteError(
    error: { message?: unknown; path?: unknown },
    mutationField: 'favoritePerformer' | 'favoriteStudio',
    duplicateConstraint: string,
  ): boolean {
    const message =
      typeof error.message === 'string' ? error.message.toLowerCase() : '';
    const path = Array.isArray(error.path)
      ? error.path.filter(
          (segment): segment is string => typeof segment === 'string',
        )
      : [];

    return (
      path.includes(mutationField) &&
      message.includes('duplicate key value violates unique constraint') &&
      message.includes(duplicateConstraint.toLowerCase())
    );
  }
}
