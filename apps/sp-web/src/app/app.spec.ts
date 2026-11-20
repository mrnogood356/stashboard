import { DeferBlockState, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), MessageService, ConfirmationService],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('does not force navigation on app startup', () => {
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigateByUrl');

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('shows a destructive confirmation once its deferred dialog has loaded', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const [confirmBlock] = await fixture.getDeferBlocks();
    await confirmBlock.render(DeferBlockState.Complete);

    TestBed.inject(ConfirmationService).confirm({
      key: 'app-destructive',
      header: 'Reset All Integrations?',
      message: 'Clears every integration.',
    });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.body.textContent).toContain('Reset All Integrations?');
  });
});
