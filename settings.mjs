const legacySettings = {
  CALLER_NUMBER: 'RINGER_CALLER_NUMBER',
  CALLER_ALTERNATE_NUMBER: 'RINGER_ALTERNATE_CALLER_NUMBER',
};

export function callerSetting(env, name) {
  return env[name] ?? env[legacySettings[name] ?? `RINGER_${name.slice('CALLER_'.length)}`];
}
