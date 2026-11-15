import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FixTakenDto } from './organizer.dto';

const errorsFor = (body: Record<string, unknown>) =>
  validateSync(plainToInstance(FixTakenDto, body)).map(
    (error) => error.property,
  );

describe('FixTakenDto', () => {
  it('needs the fix the preview showed, so nothing is merged unasked', () => {
    expect(errorsFor({ sceneIds: ['7'], fix: 'merge' })).toEqual([]);
    expect(errorsFor({ sceneIds: ['7'], fix: 'scan' })).toEqual([]);
    expect(errorsFor({ sceneIds: ['7'] })).toEqual(['fix']);
    expect(errorsFor({ sceneIds: ['7'], fix: 'delete' })).toEqual(['fix']);
  });
});
