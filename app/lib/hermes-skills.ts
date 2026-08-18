import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HERMES_PROFILE } from './hermes-config.ts';

/**
 * Reads a profile's installed skills straight off disk.
 *
 * `hermes skills list` renders a Rich table that truncates long names with an
 * ellipsis, and `hermes skills config` refuses to run without a TTY, so
 * neither is a sound source for a UI. The skills themselves are plain
 * directories with YAML frontmatter, which is stable and lossless:
 *
 *   ~/.hermes/profiles/<profile>/skills/<category>/<name>/SKILL.md
 *
 * Enabling and disabling is deliberately not offered here — Hermes only
 * exposes that through an interactive prompt, and faking it by editing state
 * Hermes owns would be a good way to corrupt a profile.
 */

export interface HermesSkill {
  name: string;
  category: string;
  description: string;
  version: string | null;
  source: 'builtin' | 'local' | 'hub';
}

/**
 * Pulls a single scalar out of a SKILL.md frontmatter block.
 * Not a YAML parser: only top-level `key: value` pairs before the closing
 * `---` are considered, which is all these files use for the fields we want.
 */
export function readFrontmatterField(markdown: string, field: string): string | null {
  if (!markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  const block = end === -1 ? markdown : markdown.slice(0, end);

  const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm');
  const match = pattern.exec(block);
  if (!match) return null;

  let value = match[1].trim();
  // Strip matching surrounding quotes, keeping any inside the text.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim() || null;
}

function classify(dirName: string, markdown: string): HermesSkill['source'] {
  const author = readFrontmatterField(markdown, 'author') ?? '';
  if (/hermes agent/i.test(author)) return 'builtin';
  return dirName ? 'local' : 'hub';
}

export async function listHermesSkills(profile?: string | null): Promise<HermesSkill[]> {
  const name = profile?.trim() || HERMES_PROFILE;
  const root = path.join(os.homedir(), '.hermes', 'profiles', name, 'skills');

  let categories: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    categories = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const skills: HermesSkill[] = [];
  await Promise.all(
    categories.map(async (category) => {
      let dirs: string[];
      try {
        const entries = await readdir(path.join(root, category), { withFileTypes: true });
        dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return;
      }

      await Promise.all(
        dirs.map(async (dir) => {
          let markdown = '';
          try {
            markdown = await readFile(path.join(root, category, dir, 'SKILL.md'), 'utf8');
          } catch {
            // A directory without a SKILL.md isn't a skill; skip it silently.
            return;
          }
          skills.push({
            name: readFrontmatterField(markdown, 'name') ?? dir,
            category,
            description: readFrontmatterField(markdown, 'description') ?? '',
            version: readFrontmatterField(markdown, 'version'),
            source: classify(dir, markdown),
          });
        }),
      );
    }),
  );

  return skills.sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}
