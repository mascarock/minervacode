#!/usr/bin/env node
/**
 * Insert a dated CHANGELOG heading for the current package version.
 *
 * Run by the `version` npm lifecycle hook (see package.json), which fires
 * after the version is bumped but before the release commit is created — so
 * anything staged here rides along in that commit. Idempotent: if the version
 * already has a heading, it does nothing. The body is a TODO placeholder for
 * the human to flesh out; the point is that every release gets an entry rather
 * than the changelog silently falling behind package.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const version = pkg.version;
const changelogUrl = new URL('CHANGELOG.md', root);

let text = readFileSync(changelogUrl, 'utf8');

// Already recorded (heading followed by space, em dash, or newline)?
if (new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`, 'm').test(text)) {
  console.log(`CHANGELOG already has an entry for ${version}; leaving it untouched.`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const entry = `## ${version} — ${date}\n\n- _TODO: describe this release._\n\n`;

const title = '# Changelog\n';
const at = text.indexOf(title);
if (at === -1) {
  text = `# Changelog\n\n${entry}${text}`;
} else {
  const after = at + title.length;
  const rest = text.slice(after).replace(/^\n/, ''); // drop one blank line if present
  text = `${text.slice(0, after)}\n${entry}${rest}`;
}

writeFileSync(changelogUrl, text);
console.log(`Inserted CHANGELOG stub for ${version} (${date}) — fill in the notes before publishing.`);
