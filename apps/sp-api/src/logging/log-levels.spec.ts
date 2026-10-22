import {
  fromNestLevel,
  isLevelEnabled,
  parseLogLevel,
  resolveEnvLogLevel,
  resolveLoggingConfig,
  unknownEnvLogLevels,
} from './log-levels';

describe('log levels', () => {
  it('defaults to info, in production and out of it', () => {
    expect(resolveEnvLogLevel({ NODE_ENV: 'production' })).toEqual({
      level: 'info',
      levelSource: 'default',
    });
    expect(resolveEnvLogLevel({}).level).toBe('info');
  });

  it('takes LOG_LEVEL in any case', () => {
    expect(resolveEnvLogLevel({ LOG_LEVEL: 'DEBUG' })).toEqual({
      level: 'debug',
      levelSource: 'LOG_LEVEL',
    });
    expect(resolveEnvLogLevel({ LOG_LEVEL: ' Trace ' }).level).toBe('trace');
    expect(resolveEnvLogLevel({ LOG_LEVEL: 'warn' }).level).toBe('warn');
    expect(resolveEnvLogLevel({ LOG_LEVEL: 'Error' }).level).toBe('error');
    expect(resolveEnvLogLevel({ LOG_LEVEL: 'Info' }).level).toBe('info');
  });

  it('ignores a LOG_LEVEL it doesn’t know', () => {
    expect(resolveEnvLogLevel({ LOG_LEVEL: 'loud' }).level).toBe('info');
  });

  it('still honours STASHBOARD_LOG_LEVELS, using the most detailed level listed', () => {
    expect(
      resolveEnvLogLevel({ STASHBOARD_LOG_LEVELS: 'error,warn,log,debug' }),
    ).toEqual({ level: 'debug', levelSource: 'STASHBOARD_LOG_LEVELS' });
    expect(
      resolveEnvLogLevel({ STASHBOARD_LOG_LEVELS: 'error,warn,log,verbose' })
        .level,
    ).toBe('trace');
    expect(
      resolveEnvLogLevel({ STASHBOARD_LOG_LEVELS: 'error,fatal' }).level,
    ).toBe('error');
    expect(
      resolveEnvLogLevel({ STASHBOARD_LOG_LEVELS: 'nonsense' }).level,
    ).toBe('info');
  });

  it('prefers LOG_LEVEL over STASHBOARD_LOG_LEVELS', () => {
    expect(
      resolveEnvLogLevel({ LOG_LEVEL: 'warn', STASHBOARD_LOG_LEVELS: 'debug' })
        .level,
    ).toBe('warn');
  });

  it('maps Nest’s levels onto Stashboard’s', () => {
    expect(fromNestLevel('log')).toBe('info');
    expect(fromNestLevel('verbose')).toBe('trace');
    expect(fromNestLevel('fatal')).toBe('error');
    expect(fromNestLevel('debug')).toBe('debug');
    expect(parseLogLevel('warning')).toBe('warn');
    expect(parseLogLevel('')).toBeNull();
  });

  it('compares levels against a threshold', () => {
    expect(isLevelEnabled('error', 'info')).toBe(true);
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('debug', 'info')).toBe(false);
    expect(isLevelEnabled('trace', 'trace')).toBe(true);
    expect(isLevelEnabled('warn', 'error')).toBe(false);
  });

  it('puts log files in APP_DATA_DIR/logs, on unless LOG_FILE=false', () => {
    expect(resolveLoggingConfig({})).toEqual({
      level: 'info',
      levelSource: 'default',
      format: 'text',
      fileDirectory: '/var/lib/stashboard/logs',
      fileEnabled: true,
    });
    expect(
      resolveLoggingConfig({
        APP_DATA_DIR: '/config',
        LOG_FORMAT: 'JSON',
        LOG_FILE: 'false',
      }),
    ).toMatchObject({
      format: 'json',
      fileDirectory: '/config/logs',
      fileEnabled: false,
    });
  });
});

describe('unknownEnvLogLevels', () => {
  it('names typos in LOG_LEVEL and STASHBOARD_LOG_LEVELS', () => {
    expect(
      unknownEnvLogLevels({
        LOG_LEVEL: 'inof',
        STASHBOARD_LOG_LEVELS: 'warn,erorr',
      }),
    ).toEqual(['inof', 'erorr']);
    expect(unknownEnvLogLevels({ LOG_LEVEL: 'DEBUG' })).toEqual([]);
  });
});
