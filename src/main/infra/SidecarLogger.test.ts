import { describe, expect, it } from 'vitest';

import { SidecarLogger, type SidecarLoggerFs } from './SidecarLogger';

function makeFs() {
  const calls: { mkdir: string[]; write: [string, string][]; append: [string, string][] } = {
    mkdir: [],
    write: [],
    append: [],
  };
  const fs: SidecarLoggerFs = {
    mkdirSync: (p) => {
      calls.mkdir.push(p);
    },
    writeFileSync: (p, d) => {
      calls.write.push([p, d]);
    },
    appendFileSync: (p, d) => {
      calls.append.push([p, d]);
    },
  };
  return { fs, calls };
}

describe('SidecarLogger', () => {
  it('creates the log dir and truncates the file on construction', () => {
    const { fs, calls } = makeFs();
    new SidecarLogger('/data/logs/sidecar.log', fs);
    expect(calls.mkdir[0]).toBe('/data/logs');
    expect(calls.write).toEqual([['/data/logs/sidecar.log', '']]);
  });

  it('append() writes through to appendFileSync', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs);
    log.append('hello\n');
    expect(calls.append).toEqual([['/data/logs/sidecar.log', 'hello\n']]);
  });

  it('never throws when the underlying fs throws', () => {
    const fs: SidecarLoggerFs = {
      mkdirSync: () => {
        throw new Error('EACCES');
      },
      writeFileSync: () => {
        throw new Error('EACCES');
      },
      appendFileSync: () => {
        throw new Error('EACCES');
      },
    };
    const log = new SidecarLogger('/x/sidecar.log', fs);
    expect(() => log.append('data')).not.toThrow();
  });

  it('caps total bytes written and stops appending past the cap', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs, 10);
    log.append('1234567'); // 7 bytes
    log.append('89012345'); // would exceed 10 — sliced to remaining 3
    log.append('more'); // capped — ignored
    const totalAppended = calls.append.map(([, d]) => d).join('');
    expect(totalAppended).toBe('1234567' + '890');
  });

  it('exposes a bound sink function', () => {
    const { fs, calls } = makeFs();
    const log = new SidecarLogger('/data/logs/sidecar.log', fs);
    const sink = log.sink;
    sink('via-sink');
    expect(calls.append).toEqual([['/data/logs/sidecar.log', 'via-sink']]);
  });
});
