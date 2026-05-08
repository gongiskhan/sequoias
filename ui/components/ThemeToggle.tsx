import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import type { ThemePreference } from '../types.js';

type Props = {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
};

const ORDER: ThemePreference[] = ['light', 'dark', 'system'];

export function ThemeToggle({ value, onChange }: Props): JSX.Element {
  const cycle = () => {
    const idx = ORDER.indexOf(value);
    const next = ORDER[(idx + 1) % ORDER.length];
    onChange(next);
  };
  const Icon = value === 'light' ? Sun : value === 'dark' ? Moon : Monitor;
  const label = value === 'light' ? 'Light' : value === 'dark' ? 'Dark' : 'System';
  return (
    <button
      className="icon-btn"
      onClick={cycle}
      title={`Theme: ${label} (click to cycle)`}
      data-testid="theme-toggle"
      aria-label={`theme ${label}`}
    >
      <Icon size={16} />
    </button>
  );
}
