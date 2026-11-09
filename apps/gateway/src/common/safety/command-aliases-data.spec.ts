import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAckText } from '../../reminders/ack-parser';
import { parseCommand } from '../../conversation/commands';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const canonicalPath = join(ROOT, 'packages', 'contracts', 'commands', 'aliases.json');

interface AliasFile {
  commands: Record<string, string[]>;
  acks: Record<string, string[]>;
  voice_commands: string[];
}
const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8')) as AliasFile;

describe('shared command aliases', () => {
  it('the gateway copy is identical to the canonical file (run `make safety-data` if not)', () => {
    const copy = readFileSync(join(__dirname, 'data', 'command-aliases.json'), 'utf8');
    expect(copy).toBe(readFileSync(canonicalPath, 'utf8'));
  });

  it('every alias of every command parses to that command (typed text and voice share the table)', () => {
    for (const [command, aliases] of Object.entries(canonical.commands)) {
      for (const alias of aliases) {
        expect([alias, parseCommand(alias)]).toEqual([alias, command]);
      }
    }
  });

  it('spoken forms parse as commands too', () => {
    expect(parseCommand('Meds dikhao.')).toBe('meds');
    expect(parseCommand('VOICE ON')).toBe('voice_on');
    expect(parseCommand('awaaz me jawab do')).toBe('voice_on');
    expect(parseCommand('reminder band karo')).toBe('stop_reminders');
  });

  it('every ack alias parses as its ack', () => {
    for (const [kind, aliases] of Object.entries(canonical.acks)) {
      for (const alias of aliases) {
        expect([alias, parseAckText(alias)]).toEqual([alias, kind]);
      }
    }
  });

  it('caregiver commands are never offered to voice', () => {
    expect(canonical.voice_commands).not.toContain('caregiver_add');
    expect(canonical.voice_commands).not.toContain('caregiver_remove');
  });

  it('a sentence that merely contains a command word is not a command', () => {
    expect(parseCommand('please delete this from my prescription')).toBeNull();
    expect(parseCommand('help me with my medicine')).toBeNull();
  });
});
