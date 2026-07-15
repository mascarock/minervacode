import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function printLogo(): Promise<void> {
  const logoPath = join(__dirname, '../../assets/logo.txt');
  try {
    const logo = await readFile(logoPath, 'utf-8');
    console.log(chalk.cyan(logo));
  } catch {
    console.log(chalk.cyan.bold('\n  Minerva CLI\n'));
  }
}
