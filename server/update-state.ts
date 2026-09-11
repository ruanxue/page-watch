import fs from 'node:fs/promises';
import path from 'node:path';

type UpdatePhase = 'idle' | 'ready' | 'applying' | 'completed' | 'failed';

export type UpdateStatus = {
  configured: boolean;
  checkedAt: string | null;
  phase: UpdatePhase;
  updateAvailable: boolean;
  message: string | null;
};

const updateStateDir = process.env.UPDATE_STATE_DIR?.trim();

function statusPath() {
  return updateStateDir ? path.join(updateStateDir, 'status.json') : null;
}

function requestPath() {
  return updateStateDir ? path.join(updateStateDir, 'update-request.json') : null;
}

function emptyStatus(): UpdateStatus {
  return { configured: Boolean(updateStateDir), checkedAt: null, phase: 'idle', updateAvailable: false, message: null };
}

function isPhase(value: unknown): value is UpdatePhase {
  return value === 'idle' || value === 'ready' || value === 'applying' || value === 'completed' || value === 'failed';
}

export async function readUpdateStatus(): Promise<UpdateStatus> {
  const file = statusPath();
  if (!file) return emptyStatus();
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStatus();
    const value = parsed as Record<string, unknown>;
    return {
      configured: true,
      checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
      phase: isPhase(value.phase) ? value.phase : 'idle',
      updateAvailable: value.updateAvailable === true,
      message: typeof value.message === 'string' ? value.message.slice(0, 240) : null
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStatus();
    return { ...emptyStatus(), phase: 'failed', message: '无法读取 NAS 更新状态。' };
  }
}

export async function requestUpdate() {
  const file = requestPath();
  if (!file || !updateStateDir) throw new Error('NAS 更新助手尚未配置。请按部署说明启用更新检查任务。');
  await fs.mkdir(updateStateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ requestedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
}
