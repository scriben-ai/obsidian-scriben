/**
 * The shapes the plugin actually receives.
 *
 * Without these the .mjs modules hand TypeScript `any`, and every value read
 * off a note became an unsafe member access — 25 of the review's warnings were
 * that one omission repeated.
 */
export interface ScribenNote {
  ref: string;
  title?: string;
  date?: string;
  type?: string;
  participants?: string[];
}

export interface ActionItem { text?: string; owner?: string; assignee?: string; due?: string; due_date?: string; }
export interface Mention { name?: string; person?: string; }
export interface MemoryFact { text?: string; }

export interface NoteExtras {
  summary?: string | null;
  actionItems?: ActionItem[];
  mentions?: Mention[];
  flagged?: { text?: string }[];
  memories?: MemoryFact[];
}

export interface VaultEntry { path: string; hash: string; }
export interface PullItem { ref: string; path: string; note: ScribenNote; renamed: boolean; }
