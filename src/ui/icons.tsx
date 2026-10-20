import {
  Atom, BookOpen, Brain, Briefcase, Calculator, Code, Dna, Dumbbell, FileText, FlaskConical, Globe, Landmark,
  Languages, Laptop, Layers, Leaf, ListChecks, Music, NotebookPen, Palette, PenLine, ScrollText, Shapes, Sigma,
  CalendarPlus, type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ResourceKind, Subject } from '../../shared/schema';
import type { CreateKind } from './types';

const subjectIcons: Record<string, LucideIcon> = {
  book: BookOpen, english: BookOpen, literature: BookOpen, reading: BookOpen,
  flask: FlaskConical, science: FlaskConical, chemistry: FlaskConical,
  calculator: Calculator, maths: Sigma, math: Sigma, mathematics: Sigma, sigma: Sigma,
  globe: Globe, geography: Globe, world: Globe,
  palette: Palette, art: Palette, design: Palette,
  music: Music,
  code: Code, computing: Laptop, computer: Laptop, laptop: Laptop, technology: Laptop,
  languages: Languages, language: Languages, french: Languages, spanish: Languages, german: Languages, chinese: Languages, japanese: Languages,
  landmark: Landmark, history: ScrollText, scroll: ScrollText, politics: Landmark, legal: Landmark,
  atom: Atom, physics: Atom,
  dna: Dna, biology: Dna,
  leaf: Leaf, environment: Leaf,
  pen: PenLine, writing: PenLine,
  brain: Brain, psychology: Brain,
  dumbbell: Dumbbell, pe: Dumbbell, sport: Dumbbell, health: Dumbbell,
  briefcase: Briefcase, business: Briefcase, economics: Briefcase,
};

export function subjectIcon(subject: Pick<Subject, 'icon' | 'name'>): LucideIcon {
  const direct = subjectIcons[subject.icon.toLowerCase()];
  if (direct) return direct;
  const words = subject.name.toLowerCase().split(/[^a-z]+/);
  for (const word of words) {
    const match = subjectIcons[word];
    if (match) return match;
  }
  return BookOpen;
}

/** CSS custom properties that tint a surface with a subject's colour, kept muted. */
export function subjectTint(color: string | undefined): CSSProperties {
  return { '--tint': color && /^#|^rgb|^hsl/.test(color) ? color : '#8b8a85' } as CSSProperties;
}

export const kindIcons: Record<CreateKind, LucideIcon> = {
  quiz: ListChecks,
  test: FileText,
  flashcards: Layers,
  diagram: Shapes,
  notes: NotebookPen,
  plan: CalendarPlus,
};

export const kindLabels: Record<CreateKind, string> = {
  quiz: 'Quiz',
  test: 'Test',
  flashcards: 'Flashcards',
  diagram: 'Diagram',
  notes: 'Notes',
  plan: 'Study plan',
};

export const kindDescriptions: Record<CreateKind, string> = {
  quiz: 'Short answers, graded as you go',
  test: 'Printable paper with LaTeX export',
  flashcards: 'Cards to flip and sort',
  diagram: 'An interactive HTML diagram',
  notes: 'A written summary of the topic',
  plan: 'Study sessions on your calendar',
};

export const resourceKinds: ResourceKind[] = ['quiz', 'test', 'flashcards', 'diagram', 'notes'];
