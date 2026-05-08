import path from 'node:path';
import { homeDir } from './paths.js';

export function claudeProjectsDir(): string {
  return path.join(homeDir(), '.claude', 'projects');
}

export function workingDirToEscapedPath(workingDir: string): string {
  return workingDir.replace(/[/.]/g, '-');
}

export function workingDirToProjectDir(workingDir: string): string {
  return path.join(claudeProjectsDir(), workingDirToEscapedPath(workingDir));
}
