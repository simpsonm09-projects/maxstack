// The checks the smoke run asserts. Each takes what the run recorded (the Pi session and the stub's
// requests) and returns { name, ok, detail }. Nothing here starts a process.
import { PLAIN_TEXT } from './stub-model-server.mjs';

const CHAT_PATH = '/v1/chat/completions';

const check = (name, ok, detail) => ({ name, ok: ok === true, detail });

// Each <skill> block of the system prompt, as its name and the location Pi gives it.
export function skillsInSystemPrompt(systemText) {
  const blocks = [...systemText.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map((match) => match[1]);
  return blocks.map((block) => ({
    name: block.match(/<name>([^<]*)<\/name>/)?.[1] ?? '',
    location: (block.match(/<location>([^<]*)<\/location>/)?.[1] ?? '').replaceAll('\\', '/'),
  }));
}

function systemTextOf(request) {
  const system = (request.body?.messages ?? []).find((message) => message.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

export function checkPiExit(session) {
  if (session.spawnError)
    return check('pi-started-and-exited-0', false, `spawn failed: ${session.spawnError}`);
  if (session.timedOut)
    return check('pi-started-and-exited-0', false, 'Pi did not exit in time and was stopped');
  return check('pi-started-and-exited-0', session.exitCode === 0, `exit code ${session.exitCode}`);
}

export function checkChatRequest(stub) {
  const count = stub.requests.filter((request) => request.path === CHAT_PATH).length;
  return check(
    'stub-received-chat-request',
    count >= 1,
    `${count} chat request(s) reached the stub`,
  );
}

// The assistant text the plain turn produced, from the message events of the session.
export function checkPlainTurn(session) {
  const texts = session.events
    .filter((record) => record.type === 'message_end' && record.message?.role === 'assistant')
    .flatMap((record) =>
      (record.message.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text),
    );
  return check(
    'plain-turn-answered',
    texts.includes(PLAIN_TEXT),
    `assistant texts: ${texts.length}`,
  );
}

// One layer's skill is in the system prompt of the first chat request, under the layer's folder.
export function checkLayerSkill(stub, skill) {
  const name = `skill-${skill.layer}-in-system-prompt`;
  if (skill.error) return check(name, false, skill.error);
  const first = stub.requests.find((request) => request.path === CHAT_PATH);
  const listed = skillsInSystemPrompt(first ? systemTextOf(first) : '');
  const found = listed.find(
    (entry) =>
      entry.name === skill.name &&
      entry.location.toLowerCase().endsWith(skill.layerPath.toLowerCase()),
  );
  return check(name, Boolean(found), `${skill.name} at ${skill.layerPath}`);
}

// PStack registers /loop from its Pi extension. RPC get_commands reports loaded extension commands.
export function checkPstackExtensionLoaded(session) {
  const response = session.events.find(
    (record) =>
      record.type === 'response' &&
      record.id === 'smoke-commands' &&
      record.command === 'get_commands',
  );
  const commands = response?.data?.commands ?? [];
  const found = commands.some(
    (command) => command.name === 'loop' && command.source === 'extension',
  );
  return check(
    'pstack-pi-extension-loaded',
    found,
    found
      ? '/loop is registered by an extension'
      : "get_commands did not report PStack's /loop extension command",
  );
}

export function checkWorkspaceUnchanged(before, after) {
  const changed = [];
  for (const [path, value] of after) if (before.get(path) !== value) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  const watched = `${before.size} file(s) in the Pi agent and wrapper folders`;
  return check(
    'workspace-unchanged',
    changed.length === 0,
    changed.length === 0 ? `no change to ${watched}` : `changed: ${changed.slice(0, 3).join(', ')}`,
  );
}
