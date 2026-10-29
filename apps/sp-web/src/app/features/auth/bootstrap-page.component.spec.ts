import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from '../../core/api/auth.service';
import { BootstrapPageComponent } from './bootstrap-page.component';

describe('BootstrapPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('explains the setup handoff and navigates directly to setup after admin creation', async () => {
    const authService = {
      status: () => null,
      bootstrap: vi.fn().mockReturnValue(
        of({
          bootstrapRequired: false,
          authenticated: true,
          username: 'admin',
        }),
      ),
    };

    await TestBed.configureTestingModule({
      imports: [BootstrapPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: authService,
        },
      ],
    }).compileComponents();

    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(BootstrapPageComponent);
    const component = fixture.componentInstance as any;

    fixture.detectChanges();

    component.form.setValue({
      username: 'admin',
      password: 'long-password-123',
      confirmPassword: 'long-password-123',
      setupCode: '',
    });
    component.submit();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(authService.bootstrap).toHaveBeenCalledWith({
      username: 'admin',
      password: 'long-password-123',
    });
    expect(fixture.nativeElement.textContent).toContain(
      'After this, Stashboard opens required integration setup',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Admin account created. Opening required integration setup next.',
    );
    expect(navigate).toHaveBeenCalledWith(['/setup'], {
      queryParams: {
        from: 'bootstrap',
      },
    });
  });

  it('asks for the setup code when the server sets one, and sends it', async () => {
    const authService = {
      status: () => ({
        bootstrapRequired: true,
        authenticated: false,
        username: null,
        setupCodeRequired: true,
      }),
      bootstrap: vi
        .fn()
        .mockReturnValue(of({ bootstrapRequired: false, authenticated: true, username: 'admin' })),
    };
    await TestBed.configureTestingModule({
      imports: [BootstrapPageComponent],
      providers: [provideRouter([]), { provide: AuthService, useValue: authService }],
    }).compileComponents();
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(BootstrapPageComponent);
    const component = fixture.componentInstance as any;
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="bootstrap-setup-code"]'),
    ).not.toBeNull();
    component.form.setValue({
      username: 'admin',
      password: 'long-password-123',
      confirmPassword: 'long-password-123',
      setupCode: '',
    });
    component.submit();
    expect(authService.bootstrap).not.toHaveBeenCalled();

    component.form.controls.setupCode.setValue(' open-sesame ');
    component.submit();
    expect(authService.bootstrap).toHaveBeenCalledWith({
      username: 'admin',
      password: 'long-password-123',
      setupCode: 'open-sesame',
    });
  });
});
