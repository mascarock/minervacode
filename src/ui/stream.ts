import process from 'node:process';

export function streamToStdout(chunk: string): void {
  process.stdout.write(chunk);
}

export function endStreamLine(): void {
  process.stdout.write('\n');
}
