import type { RefineMethodRecord } from '../contract/index.js';

/**
 * The built-in decomposition methods. They live in code, not the DB — the
 * store only holds user-defined methods (workspace-scoped `rm-*` rows).
 */
export const BUILTIN_METHODS: readonly RefineMethodRecord[] = [
  {
    id: 'builtin-vertical-slices',
    workspaceId: null,
    name: 'Vertical slices (INVEST)',
    description: 'End-to-end user-valuable increments, each independently shippable.',
    instructions:
      "Decompose into vertical slices: each task cuts through every layer (UI, API, persistence) and delivers observable user value on its own. Apply INVEST: Independent (minimal coupling between tasks), Negotiable, Valuable (a user or operator can see the difference), Estimable, Small (≤ one day of focused work), Testable (acceptance criteria verifiable against the running product). Prefer the thinnest slice that proves the flow, then widen. Never produce layer-tasks like 'build the backend' or 'create the database schema'.",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-walking-skeleton',
    workspaceId: null,
    name: 'Walking skeleton',
    description: 'Thinnest end-to-end path first, then flesh out increment by increment.',
    instructions:
      'First task: the walking skeleton — the thinnest possible end-to-end implementation of the epic touching every architectural component with hardcoded/minimal behavior, proving the wiring. Each subsequent task replaces one hardcoded piece with real behavior or adds one capability, keeping the system demoable after every task. Order tasks so the system never breaks. State explicitly in each description what the demo shows after it lands.',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-spidr',
    workspaceId: null,
    name: 'SPIDR splitting',
    description: 'Split by Spikes, Paths, Interfaces, Data, Rules.',
    instructions:
      'Split the epic using SPIDR: Spikes (time-boxed research tasks where uncertainty blocks estimation — mark them clearly and put them first), Paths (each distinct user path or branch in a flow becomes its own task), Interfaces (one interface/platform/entry-point at a time), Data (start with a subset of data types or sources, extend later), Rules (relax business rules first, tighten in later tasks). Name which SPIDR dimension each task came from in its description.',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-risk-first',
    workspaceId: null,
    name: 'Risk-first',
    description: 'Burn down technical risk and unknowns before building the bulk.',
    instructions:
      'Order the decomposition by risk: identify the assumptions most likely to sink the epic (unproven integrations, performance, unclear requirements, unfamiliar code areas) and front-load tasks that retire them — spikes, prototypes, thin proofs. Later tasks build on de-risked ground and should be routine. For each task state which risk it retires or why it is now low-risk. Prioritize accordingly: risk-retiring tasks get priority 0-1.',
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-moscow',
    workspaceId: null,
    name: 'MoSCoW scoping',
    description: 'Must/Should/Could scoping — ship the Musts, stage the rest.',
    instructions:
      "Classify everything the epic implies into Must have (the epic fails without it), Should have (important, not fatal), Could have (nice polish). Produce tasks for all three tiers: Musts as priority 0-1, Shoulds as priority 2, Coulds as priority 3. Won't-haves are not tasks — list them in the summary as explicit non-goals. Each task description names its tier.",
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
  },
];
