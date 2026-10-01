import { validateSettings } from './settings.js';

// Explicit environment settings override persisted values on every server restart.
export function applyRuntimeSettings(repository, env=process.env) {
  if(!env.MATRIX_PROVIDER?.trim()) return;
  const matrixProvider=env.MATRIX_PROVIDER.trim().toLowerCase();
  validateSettings({matrixProvider});
  if(repository.scenario().settings.matrixProvider!==matrixProvider) repository.updateSettings({matrixProvider});
}
