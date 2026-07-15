import process from 'node:process';

const INDENT = '  ';

/**
 * Writes a streamed response with a `● ` prefix on the first line and a
 * hanging indent on every following line, Claude Code style.
 */
export class BulletStreamWriter {
  private started = false;

  write(chunk: string): void {
    if (!this.started) {
      process.stdout.write('● ');
      this.started = true;
    }
    process.stdout.write(chunk.replaceAll('\n', `\n${INDENT}`));
  }

  end(): void {
    if (this.started) {
      process.stdout.write('\n');
    }
  }
}
