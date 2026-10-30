/**
 * Copies text, also on http:// addresses. Browsers only offer the clipboard
 * API on https:// (or localhost), and Stashboard is usually opened as
 * http://192.168.x.x, so there it falls back to selecting a hidden text box
 * and copying that, which works everywhere, iOS Safari included. Throws when
 * neither works. Call it straight from the click, before any other await:
 * the fallback only runs while the browser still counts it as a click.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Refused (no permission); try the other way.
    }
  }
  if (!copyWithSelection(text)) {
    throw new Error('The browser wouldn’t copy.');
  }
}

function copyWithSelection(text: string): boolean {
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  // Off screen, and big enough text that iOS doesn't zoom to it.
  box.style.position = 'fixed';
  box.style.top = '0';
  box.style.left = '-9999px';
  box.style.fontSize = '16px';
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(box);
  box.select();
  box.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  box.remove();
  focused?.focus?.();
  return copied;
}
