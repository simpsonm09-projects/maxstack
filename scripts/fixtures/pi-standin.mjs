#!/usr/bin/env node
// A stand-in for the Pi CLI in RPC mode, for the verifier's tests on a machine with no Pi. It reads
// the same environment and settings Pi reads: the agent folder, the models file for the stub's URL,
// and the skills in the settings. It builds its system prompt from those skills, in the format Pi uses.
// It sends each prompt to the stub and emits the assistant text.
//
// --standin-mode selects the behaviour: "run" (default) answers every prompt; "fail-start" exits
// before it reads a prompt.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const agentDir = process.env.PI_CODING_AGENT_DIR ?? '';
const modeIndex = process.argv.indexOf('--standin-mode');
const mode = modeIndex === -1 ? 'run' : process.argv[modeIndex + 1];
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

function skillBlocks(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const blocks = [];
  for (const dir of settings.skills ?? []) {
    const root = resolve(agentDir, dir);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const file = join(root, name, 'SKILL.md');
      if (existsSync(file))
        blocks.push(
          `  <skill>\n    <name>${name}</name>\n    <location>${file}</location>\n  </skill>`,
        );
    }
  }
  return blocks.join('\n');
}

function systemPrompt() {
  const skills = skillBlocks(join(agentDir, 'settings.json'));
  return `You are an expert coding assistant operating inside pi.\n\n<available_skills>\n${skills}\n</available_skills>\n`;
}

function stubBase() {
  const models = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'));
  return models.providers.stub.baseUrl;
}

async function chat(messages) {
  const response = await fetch(`${stubBase()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub-1', messages, stream: false }),
  });
  return (await response.json()).choices[0].message;
}

async function handlePrompt(message) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: message },
  ];
  const reply = await chat(messages);
  emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: reply.content ?? '' }] },
  });
  emit({ type: 'agent_settled', aborted: false });
}

if (mode === 'fail-start') {
  process.stderr.write('stand-in: failing at start as requested\n');
  process.exit(3);
}
emit({ type: 'standin_env', keys: Object.keys(process.env).sort() });
const lines = createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'get_commands') {
    emit({
      id: command.id,
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: [] },
    });
    return;
  }
  if (command.type !== 'prompt') return;
  emit({
    id: command.id,
    type: 'response',
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  });
  chain = chain.then(() => handlePrompt(command.message));
});
lines.on('close', () => {
  chain.then(() => process.exit(0));
});
