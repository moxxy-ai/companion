import { EmptyState, ErrorBar, Page, PageHeader, Section } from '@companion/ui';
import { useBilling } from '../hooks/useBilling.js';

export default function Billing(): JSX.Element {
  const { current, status, error } = useBilling();
  if (!current) return <Page><EmptyState title="No workspace yet" hint="Create or select a workspace first." /></Page>;
  return <Page>
    <PageHeader title="Billing" subtitle={`${current.name} — subscription status`} />
    <ErrorBar error={error} />
    <Section title="Subscription" description="Billing is scoped to the active workspace.">
      {status === null && !error ? <p className="dim">Loading billing status…</p> : null}
      {status && !status.subscribed ? <EmptyState title="Not subscribed" hint={`${current.name} does not have an active subscription.`} /> : null}
      {status?.subscribed ? <div className="card"><strong>Subscribed</strong><p className="dim">Status: {status.subscription?.status}</p></div> : null}
    </Section>
  </Page>;
}
