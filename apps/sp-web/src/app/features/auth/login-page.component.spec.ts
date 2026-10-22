import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { AuthService } from '../../core/api/auth.service';
import { LoginPageComponent } from './login-page.component';

describe('LoginPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(login: () => Observable<unknown>) {
    const authService = { login: vi.fn(login) };
    await TestBed.configureTestingModule({
      imports: [LoginPageComponent],
      providers: [provideRouter([]), { provide: AuthService, useValue: authService }],
    }).compileComponents();
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LoginPageComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const signIn = async (username: string, password: string) => {
      const [user, pass] = Array.from(root.querySelectorAll<HTMLInputElement>('input'));
      user.value = username;
      user.dispatchEvent(new Event('input'));
      pass.value = password;
      pass.dispatchEvent(new Event('input'));
      root.querySelector('form')!.dispatchEvent(new Event('submit'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { authService, navigateByUrl, fixture, root, signIn };
  }

  const httpError = (status: number, message?: string) =>
    throwError(() => new HttpErrorResponse({ status, error: message ? { message } : null }));

  it('signs in and opens the app', async () => {
    const { authService, navigateByUrl, signIn } = await render(() => of({ authenticated: true }));
    await signIn('admin', 'correct horse');

    expect(authService.login).toHaveBeenCalledWith({
      username: 'admin',
      password: 'correct horse',
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('does not send an incomplete form', async () => {
    const { authService, signIn } = await render(() => of({}));
    await signIn('ad', '');
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('explains a wrong password without saying which part was wrong', async () => {
    const { navigateByUrl, root, signIn } = await render(() =>
      httpError(401, 'Invalid username or password.'),
    );
    await signIn('admin', 'wrong');

    expect(root.textContent).toContain('Invalid username or password.');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it("shows the server's lockout wait, which grows with each block", async () => {
    const { root, signIn } = await render(() =>
      httpError(429, 'Too many wrong tries. Wait 4 minutes and try again.'),
    );
    await signIn('admin', 'wrong');
    expect(root.textContent).toContain('Wait 4 minutes');
  });

  it('points a fresh install to first-run setup', async () => {
    const { root, signIn } = await render(() => httpError(409));
    await signIn('admin', 'whatever');
    expect(root.textContent).toContain('Complete first-run bootstrap instead.');
  });

  it('disables the button while signing in', async () => {
    const pending = new Subject<unknown>();
    const { fixture, root, signIn } = await render(() => pending);
    await signIn('admin', 'correct horse');

    const button = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Signing in');
    pending.error(new HttpErrorResponse({ status: 500 }));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(root.textContent).toContain('Failed to sign in.');
  });
});
