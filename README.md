This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Pages

- `/` — Kanban board
- `/gantt` — Epics flow Gantt chart view

## Gantt chart

The Gantt page provides a timeline for epics with:

- epic duration bars
- owner and status badges
- progress indicators
- date scale for quick schedule scanning

Edit data in `src/app/gantt/page.tsx` to wire the chart to your real epics source.
