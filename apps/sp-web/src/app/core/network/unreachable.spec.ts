import { HttpErrorResponse } from '@angular/common/http';
import { isUnreachableError, safeNextUrl } from './unreachable';

describe('unreachable', () => {
  it('counts no answer and proxy errors, not the app’s own errors', () => {
    expect(isUnreachableError(new HttpErrorResponse({ status: 0 }))).toBe(true);
    expect(isUnreachableError(new HttpErrorResponse({ status: 504 }))).toBe(true);
    expect(isUnreachableError(new HttpErrorResponse({ status: 401 }))).toBe(false);
    expect(isUnreachableError(new HttpErrorResponse({ status: 500 }))).toBe(false);
    expect(isUnreachableError(new Error('nope'))).toBe(false);
  });

  it('only goes back to paths inside the app', () => {
    expect(safeNextUrl('/library?sort=new')).toBe('/library?sort=new');
    expect(safeNextUrl('//evil.example')).toBe('/');
    expect(safeNextUrl('https://evil.example')).toBe('/');
    expect(safeNextUrl('/unreachable')).toBe('/');
    expect(safeNextUrl(null)).toBe('/');
  });
});
