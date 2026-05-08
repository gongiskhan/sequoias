import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Props = {
  branch: string;
  terminalName: string;
  projectId?: string;
  active: boolean;
  readOnly?: boolean;
};

function readCssTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: get('--bg-terminal') || '#0d1014',
    foreground: get('--text') || '#d8dde4',
    cursor: get('--accent') || '#74a8d6',
    cursorAccent: get('--bg-terminal') || '#0d1014',
    selectionBackground:
      get('--terminal-selection') || 'rgba(130, 179, 224, 0.45)',
    selectionInactiveBackground:
      get('--terminal-selection-inactive') || 'rgba(130, 179, 224, 0.22)',
    selectionForeground: undefined,
  };
}

export function TerminalPane({
  branch,
  terminalName,
  projectId,
  active,
  readOnly,
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const isTouch =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches;
    const xterm = new Xterm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: isTouch ? 13 : 12,
      theme: readCssTheme(),
      cursorBlink: !isTouch && !readOnly,
      disableStdin: !!readOnly,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(hostRef.current);
    fit.fit();
    termRef.current = xterm;
    fitRef.current = fit;

    const onThemeChange = () => {
      try {
        xterm.options.theme = readCssTheme();
      } catch {
        // ignore
      }
    };
    const themeObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'data-theme') onThemeChange();
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ branch, terminal: terminalName });
    if (projectId) params.set('project', projectId);
    const url = `${proto}//${window.location.host}/ws/terminal?${params}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') xterm.write(evt.data);
    };
    if (!readOnly) {
      xterm.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
        }
      } catch {
        // ignore
      }
    });
    ro.observe(hostRef.current);

    return () => {
      themeObserver.disconnect();
      ro.disconnect();
      try { ws.close(); } catch { /* ignore */ }
      xterm.dispose();
    };
  }, [branch, terminalName, projectId, readOnly]);

  useEffect(() => {
    if (active && fitRef.current) {
      try { fitRef.current.fit(); } catch { /* ignore */ }
    }
  }, [active]);

  return (
    <div
      className="terminal-pane"
      style={{ display: active ? 'block' : 'none' }}
      data-testid={`terminal-pane-${terminalName}`}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
