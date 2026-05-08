import React, { useEffect, useState } from 'react';

type Props = {
  onClose: () => void;
  onCreate: (branch: string, baseBranch?: string) => Promise<void>;
  projectId?: string;
  projectName?: string;
};

export function NewSessionDialog({
  onClose,
  onCreate,
  projectId,
  projectName,
}: Props): JSX.Element {
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const url = projectId ? `/api/projects/${projectId}/branches` : '/api/branches';
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        setBranches(d.branches || []);
        const def = ['main', 'master'].find((m) => d.branches?.includes(m));
        if (def) setBase(def);
      });
  }, [projectId]);

  const submit = async () => {
    if (!branch.trim()) {
      setError('branch name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(branch.trim(), base || undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>New session{projectName ? ` · ${projectName}` : ''}</h2>
        <label>
          Branch
          <input
            autoFocus
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feature/auth"
            data-testid="new-session-branch"
          />
        </label>
        <label>
          Base branch
          <select
            value={base}
            onChange={(e) => setBase(e.target.value)}
            data-testid="new-session-base"
          >
            <option value="">(current)</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="dialog-error" data-testid="new-session-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy} data-testid="new-session-submit">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
