import { defineNav, NavIcon } from '@companion/core/client';

/**
 * One entry in the Board group, below the Task Board (the board module owns
 * the section; board is a hard dependency, so the section always exists when
 * this nav loads). The icon is the decomposition itself: one path in, three out.
 */
export const nav = defineNav([
  {
    key: 'refinement',
    label: 'Refinement',
    hash: '#/refinement',
    // 'r' is taken by code's Pull Requests chord — 'f' (re-f-ine) is free.
    shortcut: 'f',
    permission: 'refine:read',
    section: 'board',
    order: 10,
    freshOn: (msg) => (msg.t === 'refinement.changed' ? 'refinement' : null),
    icon: (
      <NavIcon>
        <path d="M3.5 12h6.5" />
        <path d="M10 12c4 0 4-6 8-6M10 12h8M10 12c4 0 4 6 8 6" />
        <path d="m16.5 4 2.5 2-2.5 2M16.5 10l2.5 2-2.5 2M16.5 16l2.5 2-2.5 2" />
      </NavIcon>
    ),
  },
]);
