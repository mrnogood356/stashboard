import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcquisitionScenesQueryDto } from './acquisition-scenes-query.dto';

describe('AcquisitionScenesQueryDto', () => {
  it('accepts acquisition lifecycle values', async () => {
    const instance = plainToInstance(AcquisitionScenesQueryDto, {
      lifecycle: 'IMPORT_PENDING',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
  });

  it('rejects lifecycle states outside the acquisition page scope', async () => {
    const instance = plainToInstance(AcquisitionScenesQueryDto, {
      lifecycle: 'NOT_REQUESTED',
    });

    const errors = await validate(instance);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('isIn');
  });

  it('accepts recently added', async () => {
    const instance = plainToInstance(AcquisitionScenesQueryDto, {
      lifecycle: 'AVAILABLE',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
  });

  it('accepts a search and a known sort', async () => {
    const instance = plainToInstance(AcquisitionScenesQueryDto, {
      q: 'studio name',
      sort: 'released-desc',
    });

    await expect(validate(instance)).resolves.toHaveLength(0);
  });

  it('rejects an unknown sort', async () => {
    const instance = plainToInstance(AcquisitionScenesQueryDto, {
      sort: 'random',
    });

    const errors = await validate(instance);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('isIn');
  });
});
