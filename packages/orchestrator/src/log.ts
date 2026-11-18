let lastLine = '';

/** Rewrite the single-line live progress line (terminal only). */
export function progressLine(text: string): void {
  if (!process.stdout.isTTY) return;
  if (lastLine) process.stdout.write('\r\x1b[K');
  process.stdout.write(text);
  lastLine = text;
}

export function clearProgressLine(): void {
  if (!lastLine) return;
  process.stdout.write('\r\x1b[K');
  lastLine = '';
}

export function log(message: string): void {
  clearProgressLine();
  process.stdout.write(message + '\n');
}
