import * as store from './store.js';
import { routerComplete } from './router-client.js';

const TICK_MS = Number(process.env.VF_MISSION_TICK_MS || 500);
const MODEL = process.env.VF_MISSION_MODEL || 'gpt-4o';
const running = new Set();
let timer = null;

const nowIso = () => new Date().toISOString();

export function addStep(mission, kind, detail) {
  mission.steps.push({ at: nowIso(), kind, detail });
  return mission.steps[mission.steps.length - 1];
}

export function startWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  let mission;
  try {
    mission = store.nextQueuedMission();
  } catch {
    return;
  }
  if (!mission || running.has(mission.id)) return;
  running.add(mission.id);
  runMission(mission)
    .catch(() => {})
    .finally(() => running.delete(mission.id));
}

export async function runMission(mission) {
  mission.status = 'running';
  addStep(mission, 'model_call', 'Calling the router');
  store.updateMission(mission);

  try {
    const out = await routerComplete({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are Voidframe, a focused autonomous agent. Answer the mission prompt directly and concisely.',
        },
        { role: 'user', content: mission.prompt },
      ],
    });
    const fresh = store.getMission(mission.id);
    if (!fresh || fresh.status === 'cancelled') return fresh;

    mission.result = {
      content: out.content,
      model: out.model || MODEL,
      provider: out.provider || null,
      usage: out.usage || null,
    };
    addStep(mission, 'model_call', `${out.provider || 'router'} replied with ${out.content.length} characters`);
    store.addUsage(mission.user_id, out.usage?.prompt_tokens, out.usage?.completion_tokens);

    if (mission.autonomy === 'restricted') {
      mission.status = 'awaiting_approval';
      addStep(mission, 'approval', 'Waiting for approval before finalising');
    } else {
      addStep(mission, 'finalize', 'Mission complete');
      mission.status = 'done';
    }
  } catch (err) {
    const detail = String(err.message || err).slice(0, 240);
    mission.warning = detail;
    addStep(mission, 'warn', `Model call failed: ${detail}`);
    addStep(mission, 'finalize', 'Completed with warnings');
    mission.status = 'done';
  }

  store.updateMission(mission);
  return mission;
}
