import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLocalSceneDto, isCalendarDate } from './local-library.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(UpdateLocalSceneDto, body))).map(
    (error) => error.property,
  );

describe('UpdateLocalSceneDto', () => {
  it('takes only real calendar days as a release date, and null to clear it', async () => {
    expect(await errorsFor({ date: '2024-02-29' })).toEqual([]);
    expect(await errorsFor({ date: null })).toEqual([]);
    expect(await errorsFor({ date: '2025-02-29' })).toEqual(['date']);
    expect(await errorsFor({ date: '2025-02-30' })).toEqual(['date']);
    expect(await errorsFor({ date: '2025-99-99' })).toEqual(['date']);
    expect(await errorsFor({ date: '2 Jan 2025' })).toEqual(['date']);
  });

  it('knows leap years', () => {
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
    expect(isCalendarDate('2025-12-31')).toBe(true);
    expect(isCalendarDate('2025-13-01')).toBe(false);
  });
});
