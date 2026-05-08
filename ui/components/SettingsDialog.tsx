import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

type StoredTerminal = {
  name: string;
  cwd: string;
  cmd: string | null;
  autostart: boolean;
  background: boolean;
};

type Props = {
  onClose: () => void;
};

export function SettingsDialog({ onClose }: Props): JSX.Element {
  const [rows, setRows] = useState<StoredTerminal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => setRows(d.storedTerminals || []))
      .catch(() => undefined);
  }, []);

  const updateRow = (i: number, patch: Partial<StoredTerminal>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { name: '', cwd: '.', cmd: '', autostart: true, background: false },
    ]);
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const payload = {
        terminals: rows.map((r) => ({
          name: r.name.trim(),
          cwd: r.cwd.trim() || '.',
          cmd: typeof r.cmd === 'string' && r.cmd.trim().length > 0 ? r.cmd : null,
          autostart: r.autostart,
          background: r.background,
        })),
      };
      const res = await fetch('/api/project/terminals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `request failed: ${res.status}`);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-dialog"
      >
        <h2>Project terminals</h2>
        <p className="dialog-hint">
          Extra terminals spawned for every session. Each gets the session's allocated ports as
          <code>SEQUOIAS_PORT_&lt;NAME&gt;</code> env vars. Claude is implicit and always present.
        </p>
        <div className="settings-rows">
          <div className="settings-row settings-header">
            <div>Name</div>
            <div>Cwd</div>
            <div>Command</div>
            <div>Autostart</div>
            <div />
          </div>
          {rows.length === 0 && (
            <div className="settings-empty">No extra terminals configured.</div>
          )}
          {rows.map((row, i) => (
            <div className="settings-row" key={i}>
              <input
                placeholder="cortex"
                value={row.name}
                onChange={(e) => updateRow(i, { name: e.target.value })}
                data-testid={`settings-name-${i}`}
              />
              <input
                placeholder="cortex"
                value={row.cwd}
                onChange={(e) => updateRow(i, { cwd: e.target.value })}
                data-testid={`settings-cwd-${i}`}
              />
              <input
                placeholder="npm run dev"
                value={row.cmd ?? ''}
                onChange={(e) => updateRow(i, { cmd: e.target.value })}
                data-testid={`settings-cmd-${i}`}
              />
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={row.autostart}
                  onChange={(e) => updateRow(i, { autostart: e.target.checked })}
                  data-testid={`settings-autostart-${i}`}
                />
              </label>
              <button
                className="icon-btn"
                onClick={() => removeRow(i)}
                title="Remove"
                data-testid={`settings-remove-${i}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="settings-add"
          onClick={addRow}
          data-testid="settings-add"
        >
          <Plus size={13} /> Add terminal
        </button>
        {error && <div className="dialog-error" data-testid="settings-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            data-testid="settings-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
