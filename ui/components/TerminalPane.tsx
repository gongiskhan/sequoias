import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Props = {
  branch: string;
  terminalName: string;
  active: boolean;
};

export function TerminalPane({ branch, terminalName, active }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const xterm = new Xterm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#07090c' },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(hostRef.current);
    fit.fit();
    termRef.current = xterm;
    fitRef.current = fit;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/terminal?branch=${encodeURIComponent(branch)}&terminal=${encodeURIComponent(terminalName)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }));
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') xterm.write(evt.data);
    };
    xterm.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

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
      ro.disconnect();
      try { ws.close(); } catch { /* ignore */ }
      xterm.dispose();
    };
  }, [branch, terminalName]);

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
